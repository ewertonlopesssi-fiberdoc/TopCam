import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { lastLine, privateDir, run, writePrivate } from "./tools.js";

export interface OwnerDb {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface Manifest {
  format: 1;
  file_name: string;
  created_at: string;
  app_version: string;
  public_host: string;
  migrations: string[];
  counts: Record<string, number>;
  db_size_bytes: number;
}

/** Contagens e migrations para o resumo (confere a restauração depois). */
async function describeDb(
  db: OwnerDb,
): Promise<Pick<Manifest, "migrations" | "counts" | "db_size_bytes">> {
  const c = new pg.Client({ ...db });
  await c.connect();
  try {
    const migrations = (
      await c.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")
    ).rows.map((r) => r.version);
    const counts: Record<string, number> = {};
    for (const t of [
      "tenants",
      "users",
      "cameras",
      "recording_segments",
      "camera_events",
      "audit_logs",
    ]) {
      counts[t] = Number(
        (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n,
      );
    }
    const size = Number(
      (await c.query<{ s: string }>("SELECT pg_database_size(current_database()) AS s")).rows[0]!.s,
    );
    return { migrations, counts, db_size_bytes: size };
  } finally {
    await c.end();
  }
}

/**
 * Gera <outDir>/<name>: tar com topcam.dump (pg_dump -Fc), topcam.env e manifest.json,
 * cifrado com AES-256 (OpenPGP simétrico). Confere abrindo de novo antes de devolver.
 */
export async function createArchive(opts: {
  db: OwnerDb;
  envFile: string;
  passphrase: string;
  outDir: string;
  name: string;
  appVersion: string;
  publicHost: string;
}): Promise<{ file: string; size: number; manifest: Manifest }> {
  const tmp = await privateDir("topcam-bkp-");
  try {
    const pgEnv = {
      PGHOST: opts.db.host,
      PGPORT: String(opts.db.port),
      PGUSER: opts.db.user,
      PGPASSWORD: opts.db.password,
      PGDATABASE: opts.db.database,
    };
    const dump = await run(
      "pg_dump",
      ["-Fc", "-Z", "6", "--no-password", "-f", join(tmp.dir, "topcam.dump")],
      { env: pgEnv, timeoutMs: 15 * 60_000 },
    );
    if (dump.code !== 0) throw new Error(`Falha no dump do banco: ${lastLine(dump.stderr)}`);

    await copyFile(opts.envFile, join(tmp.dir, "topcam.env"));
    const manifest: Manifest = {
      format: 1,
      file_name: opts.name,
      created_at: new Date().toISOString(),
      app_version: opts.appVersion,
      public_host: opts.publicHost,
      ...(await describeDb(opts.db)),
    };
    await writePrivate(join(tmp.dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    const tar = await run(
      "tar",
      [
        "-cf",
        join(tmp.dir, "backup.tar"),
        "-C",
        tmp.dir,
        "manifest.json",
        "topcam.dump",
        "topcam.env",
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (tar.code !== 0) throw new Error(`Falha ao empacotar: ${lastLine(tar.stderr)}`);

    const gnupg = join(tmp.dir, "gnupg");
    await mkdir(gnupg, { mode: 0o700 });
    await writePrivate(join(tmp.dir, "pp"), opts.passphrase);
    await mkdir(opts.outDir, { recursive: true });
    const out = join(opts.outDir, opts.name);
    const gpgBase = [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--passphrase-file",
      join(tmp.dir, "pp"),
    ];
    const enc = await run(
      "gpg",
      [
        ...gpgBase,
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--s2k-mode",
        "3",
        "--s2k-digest-algo",
        "SHA512",
        "--s2k-count",
        "65011712",
        "--compress-algo",
        "none",
        "-o",
        `${out}.tmp`,
        join(tmp.dir, "backup.tar"),
      ],
      { env: { GNUPGHOME: gnupg }, timeoutMs: 10 * 60_000 },
    );
    if (enc.code !== 0) throw new Error(`Falha ao cifrar: ${lastLine(enc.stderr)}`);

    // Conferência: abre com a mesma senha e lista o conteúdo.
    const check = await run(
      "sh",
      ["-c", 'set -o pipefail; gpg "$@" --decrypt "$OUT" | tar -tf -', "sh", ...gpgBase],
      { env: { GNUPGHOME: gnupg, OUT: `${out}.tmp` }, timeoutMs: 10 * 60_000 },
    );
    const listed = check.stdout.split("\n").map((l) => l.trim());
    if (
      check.code !== 0 ||
      !["manifest.json", "topcam.dump", "topcam.env"].every((f) => listed.includes(f))
    )
      throw new Error(`O arquivo cifrado não passou na conferência: ${lastLine(check.stderr)}`);

    await rename(`${out}.tmp`, out);
    return { file: out, size: (await stat(out)).size, manifest };
  } finally {
    await tmp.cleanup();
  }
}
