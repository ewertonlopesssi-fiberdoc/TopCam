import { join } from "node:path";
import type { BackupProtocol } from "@topcam/shared";
import { lastLine, privateDir, run, writePrivate } from "./tools.js";

/** Destino já com os segredos abertos (só existe em memória, durante a execução). */
export interface Destination {
  protocol: BackupProtocol;
  host: string;
  port: number;
  username: string;
  password: string | null;
  privateKey: string | null;
  path: string;
  verifyCertificate: boolean;
  hostKeys: string | null;
}

export class TransferError extends Error {
  constructor(
    message: string,
    readonly hostKeyChanged = false,
  ) {
    super(message);
  }
}

/** Traduz as mensagens do lftp/ssh para português. */
export function explainTransferError(stderr: string, timedOut: boolean): TransferError {
  const s = stderr.toLowerCase();
  if (timedOut) return new TransferError("Tempo esgotado falando com o servidor de destino");
  if (
    s.includes("host key verification failed") ||
    s.includes("remote host identification has changed")
  )
    return new TransferError(
      'A identidade do servidor SFTP não confere com a registrada. Se o servidor foi trocado de propósito, use "Aceitar nova identidade" e teste de novo.',
      true,
    );
  if (/must use encryption|ssl required|tls required|encryption required/.test(s))
    return new TransferError("O servidor exige conexão criptografada: escolha FTPS");
  if (/login incorrect|login failed|authentication failed|permission denied \(|530 /.test(s))
    return new TransferError("Usuário, senha ou chave recusados pelo servidor");
  if (s.includes("connection refused"))
    return new TransferError("Conexão recusada: confira o servidor e a porta");
  if (
    /name or service not known|temporary failure in name resolution|does not resolve|not known|no address associated/.test(
      s,
    )
  )
    return new TransferError("Servidor não encontrado: confira o nome ou o IP");
  if (
    /no route to host|network is unreachable|connection timed out|operation timed out|max-retries exceeded/.test(
      s,
    )
  )
    return new TransferError(
      "Servidor inacessível (sem resposta): confira endereço, porta e firewall",
    );
  if (s.includes("certificate") && (s.includes("verif") || s.includes("not trusted")))
    return new TransferError(
      'O certificado do servidor FTPS não é confiável. Se for um certificado próprio, desmarque "Conferir certificado"',
    );
  if (/\b55[0-3]\b|access failed|permission denied/.test(s))
    return new TransferError(
      "O servidor recusou gravar na pasta: confira a pasta e as permissões do usuário",
    );
  if (/no space|disk full|quota|452 /.test(s)) return new TransferError("Sem espaço no destino");
  return new TransferError(`Falha na transferência: ${lastLine(stderr) || "erro desconhecido"}`);
}

/** Lê a identidade (chaves públicas) do servidor SSH e a impressão digital principal. */
export async function scanHostKey(
  host: string,
  port: number,
): Promise<{ lines: string; fingerprint: string }> {
  const r = await run(
    "ssh-keyscan",
    ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host],
    {
      timeoutMs: 20_000,
    },
  );
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) {
    if (!r.stderr.trim() && !r.timedOut)
      throw new TransferError(
        `O servidor não respondeu como SFTP na porta ${port}: confira a porta e o firewall`,
      );
    throw explainTransferError(r.stderr || "connection timed out", r.timedOut);
  }
  const tmp = await privateDir("topcam-kh-");
  try {
    const pick = lines.find((l) => l.includes("ssh-ed25519")) ?? lines[0]!;
    await writePrivate(join(tmp.dir, "k"), `${pick}\n`);
    const fp = await run("ssh-keygen", ["-l", "-f", join(tmp.dir, "k")], { timeoutMs: 10_000 });
    const [bits, hash, , type] = fp.stdout.trim().split(/\s+/);
    return {
      lines: `${lines.join("\n")}\n`,
      fingerprint: `${type ?? ""} ${hash ?? ""} (${bits ?? "?"} bits)`.trim(),
    };
  } finally {
    await tmp.cleanup();
  }
}

/** Executa comandos lftp no destino. Retorna a saída padrão. */
export async function lftp(
  dest: Destination,
  commands: string[],
  timeoutMs: number,
): Promise<string> {
  const tmp = await privateDir("topcam-lftp-");
  try {
    const lines = [
      "set cmd:fail-exit yes",
      "set net:timeout 20",
      "set net:max-retries 2",
      "set net:reconnect-interval-base 3",
      "set xfer:clobber yes",
    ];
    let scheme = "ftp";
    if (dest.protocol === "sftp") {
      if (!dest.hostKeys)
        throw new TransferError(
          'Identidade do servidor SFTP ainda não registrada: use "Testar conexão"',
        );
      await writePrivate(join(tmp.dir, "known_hosts"), dest.hostKeys);
      const ssh = [
        "ssh -a -x",
        "-o StrictHostKeyChecking=yes",
        `-o UserKnownHostsFile=${join(tmp.dir, "known_hosts")}`,
        "-o GlobalKnownHostsFile=/dev/null",
        "-o ConnectTimeout=20",
      ];
      if (dest.privateKey) {
        await writePrivate(
          join(tmp.dir, "id"),
          dest.privateKey.endsWith("\n") ? dest.privateKey : `${dest.privateKey}\n`,
        );
        ssh.push(
          `-i ${join(tmp.dir, "id")}`,
          "-o IdentitiesOnly=yes",
          "-o PreferredAuthentications=publickey",
        );
      }
      lines.push("set sftp:auto-confirm no", `set sftp:connect-program "${ssh.join(" ")}"`);
      scheme = "sftp";
    } else if (dest.protocol === "ftps") {
      lines.push(
        "set ftp:ssl-force true",
        "set ftp:ssl-protect-data true",
        "set ftp:ssl-protect-list true",
        `set ssl:verify-certificate ${dest.verifyCertificate ? "yes" : "no"}`,
        "set ftp:passive-mode true",
      );
      if (dest.port === 990) scheme = "ftps";
    } else {
      lines.push("set ftp:ssl-allow false", "set ftp:passive-mode true");
    }
    const userSpec = dest.privateKey ? `"${dest.username},"` : `"${dest.username}"`;
    const pw = dest.privateKey ? "" : "--env-password ";
    lines.push(
      `open ${pw}-u ${userSpec} ${scheme}://${dest.host}:${dest.port}`,
      ...commands,
      "bye",
    );
    await writePrivate(join(tmp.dir, "script"), `${lines.join("\n")}\n`);
    const r = await run("lftp", ["-f", join(tmp.dir, "script")], {
      env: { HOME: tmp.dir, LFTP_PASSWORD: dest.password ?? "" },
      timeoutMs,
    });
    if (r.code !== 0 || r.timedOut) throw explainTransferError(r.stderr, r.timedOut);
    return r.stdout;
  } finally {
    await tmp.cleanup();
  }
}

const q = (s: string) => `"${s.replace(/"/g, "")}"`;

/** Teste: cria a pasta, grava e apaga um arquivo pequeno, lista os backups existentes. */
export async function testDestination(dest: Destination, probeFile: string): Promise<string[]> {
  const out = await lftp(
    dest,
    [
      `mkdir -p -f ${q(dest.path)}`,
      `cd ${q(dest.path)}`,
      `put ${q(probeFile)} -o ".topcam-teste"`,
      `rm ".topcam-teste"`,
      "cls -1",
    ],
    120_000,
  );
  return listNames(out);
}

/** Envia o arquivo como .part e renomeia no fim (arquivo pela metade nunca conta como backup). */
export async function uploadBackup(
  dest: Destination,
  localFile: string,
  name: string,
): Promise<string[]> {
  const out = await lftp(
    dest,
    [
      `mkdir -p -f ${q(dest.path)}`,
      `cd ${q(dest.path)}`,
      `put ${q(localFile)} -o ${q(`${name}.part`)}`,
      `mv ${q(`${name}.part`)} ${q(name)}`,
      "cls -1",
    ],
    30 * 60_000,
  );
  const names = listNames(out);
  if (!names.includes(name))
    throw new TransferError("O arquivo não apareceu no destino depois do envio");
  return names;
}

export async function removeRemote(dest: Destination, names: string[]): Promise<void> {
  if (!names.length) return;
  await lftp(dest, [`cd ${q(dest.path)}`, ...names.map((n) => `rm ${q(n)}`)], 120_000);
}

function listNames(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim().replace(/\/$/, ""))
    .map((l) => l.split("/").at(-1) ?? l)
    .filter(Boolean);
}
