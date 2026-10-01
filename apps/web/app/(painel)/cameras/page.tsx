"use client";

import {
  ChevronDown,
  ChevronRight,
  Camera as CameraIcon,
  Download,
  Eye,
  Film,
  EyeOff,
  KeyRound,
  Loader2,
  MonitorPlay,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Confirm,
  CopyButton,
  DataTable,
  Drawer,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  useToast,
  type Column,
} from "@/components/ui";
import {
  MOTION_DEFAULT,
  MOTION_SOURCE_LABEL,
  MotionCredentialBox,
  MotionSettings,
  type MotionValue,
} from "@/components/motion-settings";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CAMERA_STATUS, TENANT_STATUS, fmtBytes, fmtDateTime, fmtRelative } from "@/lib/format";

interface Camera {
  id: string;
  code: string;
  name: string;
  description: string | null;
  tenantId: string;
  tenantName: string;
  locationId: string;
  locationName: string;
  groupId: string | null;
  groupName: string | null;
  ingestProtocol: string;
  status: string;
  statusReason: string | null;
  statusChangedAt: string;
  lastVideoAt: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  recordingEnabled: boolean;
  recordingMode: "continuous" | "motion";
  retentionPolicyId: string | null;
  retentionPolicyName: string | null;
  motionSource: MotionValue["motionSource"];
  motionSensitivity: number;
  alarmEnabled: boolean;
  alarmSchedule: MotionValue["alarmSchedule"];
  alarmCooldownS: number;
  alarmEmail: boolean;
  lastMotionAt: string | null;
  motionCredential?: boolean;
  motionSmtpUser?: string | null;
  motionSmtpRotatedAt?: string | null;
  enabled: boolean;
  streamKeyPrefix?: string;
  streamKeyRotatedAt?: string;
  createdAt: string;
}

interface Loc {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  groups: { id: string; name: string }[];
}
interface Ingest {
  server: string;
  streamKey: string;
  url: string;
}

function StatusCell({ c }: { c: Camera }) {
  const s = CAMERA_STATUS[c.status] ?? { label: c.status, tone: "slate" as const };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

function IngestBox({ ingest, title }: { ingest: Ingest; title?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-3">
      {title && <p className="text-sm text-slate-700">{title}</p>}
      <Field label="Servidor (URL)">
        <div className="flex gap-2">
          <input
            className="input font-mono text-xs"
            readOnly
            value={ingest.server}
            aria-label="Servidor (URL)"
          />
          <CopyButton value={ingest.server} />
        </div>
      </Field>
      <Field label="Chave de transmissão (stream key)">
        <div className="flex gap-2">
          <input
            className="input font-mono text-xs"
            readOnly
            type={show ? "text" : "password"}
            value={ingest.streamKey}
            data-testid="stream-key"
            aria-label="Chave de transmissão"
          />
          <button
            className="icon-btn h-10 w-10"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Ocultar chave" : "Mostrar chave"}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <CopyButton value={ingest.streamKey} />
        </div>
      </Field>
      <Field
        label="Se a câmera tiver um campo único de URL"
        hint="Use H.264, áudio AAC (ou desligado), GOP de 2 s, 1–2 Mbps."
      >
        <div className="flex gap-2">
          <input
            className="input font-mono text-xs"
            readOnly
            type={show ? "text" : "password"}
            value={ingest.url}
            aria-label="URL completa"
          />
          <CopyButton value={ingest.url} />
        </div>
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ formulário
function CameraForm({
  open,
  camera,
  locations,
  tenants,
  retention,
  onClose,
  onSaved,
  onTransfer,
}: {
  open: boolean;
  camera: Camera | null;
  locations: Loc[];
  tenants: { id: string; name: string }[];
  retention: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (ingest?: Ingest) => void;
  /** Só para a equipe da plataforma: abre a transferência para outro cliente. */
  onTransfer?: (camera: Camera) => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** off = só ao vivo; continuous = contínua; motion = só com movimento. */
  const [recMode, setRecMode] = useState<"off" | "continuous" | "motion">("off");
  const [retentionId, setRetentionId] = useState("");
  const [motion, setMotion] = useState<MotionValue>(MOTION_DEFAULT);
  const recording = recMode !== "off";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTenantId(camera?.tenantId ?? tenants[0]?.id ?? "");
    setLocationId(camera?.locationId ?? "");
    setGroupId(camera?.groupId ?? "");
    setName(camera?.name ?? "");
    setDescription(camera?.description ?? "");
    setRecMode(
      camera?.recordingEnabled
        ? camera.recordingMode === "motion"
          ? "motion"
          : "continuous"
        : "off",
    );
    setRetentionId(camera?.retentionPolicyId ?? retention[0]?.id ?? "");
    setMotion(
      camera
        ? {
            motionSource: camera.motionSource,
            motionSensitivity: camera.motionSensitivity,
            alarmEnabled: camera.alarmEnabled,
            alarmSchedule: camera.alarmSchedule ?? { rules: [] },
            alarmCooldownS: camera.alarmCooldownS,
            alarmEmail: camera.alarmEmail,
          }
        : MOTION_DEFAULT,
    );
  }, [open, camera, tenants, retention]);

  const tenantLocs = locations.filter((l) => l.tenantId === tenantId);
  const groups = tenantLocs.find((l) => l.id === locationId)?.groups ?? [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        description: description || null,
        locationId,
        groupId: groupId || null,
        recordingEnabled: recording,
        recordingMode: recMode === "motion" ? "motion" : "continuous",
        retentionPolicyId: recording ? retentionId || null : null,
        ...motion,
      };
      if (camera) {
        await api.patch(`/cameras/${camera.id}`, body);
        onSaved();
      } else {
        const r = await api.post<{ ingest?: Ingest }>("/cameras", { ...body, tenantId });
        onSaved(r.ingest);
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      wide
      title={camera ? `Editar ${camera.code}` : "Nova câmera"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={busy || name.trim().length < 2 || !locationId}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}{" "}
            {camera ? "Salvar" : "Cadastrar e gerar chave"}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Field label="Cliente *">
            <select
              className="input"
              value={tenantId}
              disabled={!!camera}
              onChange={(e) => (setTenantId(e.target.value), setLocationId(""), setGroupId(""))}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          {camera && onTransfer && (
            <button
              type="button"
              className="mt-1 text-xs font-medium text-brand-600 hover:underline"
              onClick={() => onTransfer(camera)}
            >
              Transferir para outro cliente…
            </button>
          )}
        </div>
        <Field label="Nome *">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Entrada Principal"
          />
        </Field>
        <Field
          label="Local *"
          hint={tenantLocs.length === 0 ? "Cadastre um local em Grupos / Locais." : undefined}
        >
          <select
            className="input"
            value={locationId}
            onChange={(e) => (setLocationId(e.target.value), setGroupId(""))}
          >
            <option value="">Selecione…</option>
            {tenantLocs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Grupo">
          <select
            className="input"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            disabled={!locationId}
          >
            <option value="">Sem grupo</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div
          className="rounded-xl border border-line p-3 sm:col-span-2"
          data-testid="recording-settings"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Gravação">
              <select
                className="input"
                value={recMode}
                onChange={(e) => setRecMode(e.target.value as typeof recMode)}
                data-testid="recording-mode"
              >
                <option value="off">Somente ao vivo (não grava)</option>
                <option value="continuous">Contínua</option>
                <option value="motion">Só com movimento</option>
              </select>
            </Field>
            {recording && (
              <Field label="Retenção">
                <select
                  className="input"
                  value={retentionId}
                  onChange={(e) => setRetentionId(e.target.value)}
                >
                  {retention.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          {recMode === "motion" && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Guarda cada movimento com 10 s antes e 30 s depois, pela retenção escolhida. O que não
              teve movimento é apagado depois de 1 hora.
              {motion.motionSource === "off" &&
                " Escolha abaixo de onde vem a detecção de movimento."}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-line p-3 sm:col-span-2">
          <div className="mb-2 text-sm font-medium">Movimento e alarme</div>
          <MotionSettings value={motion} onChange={setMotion} />
        </div>
        {!camera && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:col-span-2">
            O código (CAM-###) e a chave RTMP exclusiva são gerados automaticamente. Não é preciso
            informar IP nem senha da câmera.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ gravação (resumo)
interface RecordingSummary {
  status: string;
  recordingEnabled: boolean;
  globalEnabled: boolean;
  retentionHours: number | null;
  lastDurableSegmentAt: string | null;
  segments: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  corrupt: number;
  missing: number;
  gaps24h: number;
}

function RecordingPanel({ cameraId }: { cameraId: string }) {
  const [r, setR] = useState<RecordingSummary | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<RecordingSummary>(`/cameras/${cameraId}/recordings/summary`)
        .then((x) => alive && setR(x))
        .catch(() => alive && setHidden(true));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cameraId]);
  if (hidden || !r || (!r.recordingEnabled && r.segments === 0)) return null;
  const hours =
    r.oldest && r.newest
      ? (new Date(r.newest).getTime() - new Date(r.oldest).getTime()) / 3_600_000
      : 0;
  const state = !r.globalEnabled
    ? { text: "Gravação geral desligada (Configurações)", tone: "amber" as const }
    : r.status === "gravando"
      ? { text: "Gravando", tone: "green" as const }
      : r.recordingEnabled
        ? {
            text: ["ao_vivo", "validando", "recebendo"].includes(r.status)
              ? "Aguardando o primeiro segmento"
              : "Parada: câmera sem sinal",
            tone: "amber" as const,
          }
        : { text: "Gravação desmarcada no cadastro", tone: "slate" as const };
  const items: [string, React.ReactNode][] = [
    ["Situação", <Badge tone={state.tone}>{state.text}</Badge>],
    ["Último segmento", r.lastDurableSegmentAt ? fmtRelative(r.lastDurableSegmentAt) : "—"],
    [
      "Disponível",
      r.segments
        ? `${hours.toFixed(1).replace(".", ",")} h (${r.segments} segmentos)${
            r.retentionHours ? ` · retenção ${r.retentionHours} h` : ""
          }`
        : "—",
    ],
    ["Espaço usado", fmtBytes(r.bytes)],
    ["Lacunas (24 h)", r.gaps24h ? `${r.gaps24h}` : "nenhuma"],
  ];
  if (r.corrupt || r.missing)
    items.push([
      "Problemas",
      <span className="text-red-600">
        {r.corrupt} inválido(s), {r.missing} ausente(s)
      </span>,
    ]);
  return (
    <section className="mt-6 rounded-xl border border-line p-4" data-testid="recording-panel">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <Film size={16} /> Gravação
      </h3>
      <dl className="space-y-2 text-sm">
        {items.map(([k, v]) => (
          <div key={k} className="grid grid-cols-5 gap-2">
            <dt className="col-span-2 text-muted">{k}</dt>
            <dd className="col-span-3">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ detalhes
function CameraDrawer({
  camera,
  onClose,
  onChanged,
}: {
  camera: Camera | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canKeys = auth.can("cameras.keys");
  const [ingest, setIngest] = useState<Ingest | null>(null);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setIngest(null), [camera]);
  if (!camera) return null;
  const rows: [string, React.ReactNode][] = [
    ["Código", <span className="font-mono">{camera.code}</span>],
    ["Cliente", camera.tenantName],
    ["Local / Grupo", `${camera.locationName}${camera.groupName ? ` › ${camera.groupName}` : ""}`],
    ["Status", <StatusCell c={camera} />],
    ["Último vídeo", fmtRelative(camera.lastVideoAt)],
    ["Protocolo", camera.ingestProtocol === "rtmp_push" ? "RTMP (push)" : camera.ingestProtocol],
    [
      "Vídeo",
      camera.videoCodec
        ? `${camera.videoCodec.toUpperCase()} ${camera.width}x${camera.height} @ ${camera.fps ?? "?"} fps`
        : "—",
    ],
    ["Áudio", camera.audioCodec ?? (camera.videoCodec ? "sem áudio" : "—")],
    [
      "Bitrate",
      camera.bitrateKbps ? `${(camera.bitrateKbps / 1000).toFixed(1).replace(".", ",")} Mbps` : "—",
    ],
    [
      "Gravação",
      camera.recordingEnabled
        ? `${camera.recordingMode === "motion" ? "Só com movimento" : "Contínua"} · ${camera.retentionPolicyName ?? ""}`
        : "Somente ao vivo",
    ],
    ["Movimento", MOTION_SOURCE_LABEL[camera.motionSource] ?? camera.motionSource],
    [
      "Alarme",
      camera.alarmEnabled
        ? camera.alarmSchedule?.rules?.length
          ? `Ligado · ${camera.alarmSchedule.rules.length} faixa(s) de horário`
          : "Ligado · sempre"
        : "Desligado",
    ],
    ["Cadastrada em", fmtDateTime(camera.createdAt)],
  ];
  return (
    <Drawer open title={`${camera.code} · ${camera.name}`} onClose={onClose}>
      <dl className="space-y-2.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-5 gap-2">
            <dt className="col-span-2 text-muted">{k}</dt>
            <dd className="col-span-3 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <RecordingPanel cameraId={camera.id} />
      {canKeys && camera.motionSource === "camera" && (
        <MotionCredentialBox
          cameraId={camera.id}
          user={camera.motionSmtpUser}
          rotatedAt={camera.motionSmtpRotatedAt}
          lastMotionAt={camera.lastMotionAt}
          onChanged={onChanged}
        />
      )}
      {canKeys && (
        <section className="mt-6 rounded-xl border border-line p-4">
          <h3 className="mb-1 flex items-center gap-2 font-semibold">
            <KeyRound size={16} /> Configuração RTMP
          </h3>
          <p className="mb-3 text-xs text-muted">
            Chave terminada em <span className="font-mono">{camera.streamKeyPrefix}…</span>
            {camera.streamKeyRotatedAt && (
              <> · gerada em {fmtDateTime(camera.streamKeyRotatedAt)}</>
            )}
            . Exibir a chave fica registrado na auditoria.
          </p>
          {ingest ? (
            <IngestBox ingest={ingest} />
          ) : (
            <button
              className="btn-secondary w-full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setIngest(await api.get<Ingest>(`/cameras/${camera.id}/stream-key`));
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Eye size={16} /> Exibir dados de configuração
            </button>
          )}
          <button
            className="btn-secondary mt-2 w-full text-red-600"
            onClick={() => setRotating(true)}
          >
            <RefreshCw size={16} /> Trocar chave
          </button>
        </section>
      )}
      <Confirm
        open={rotating}
        danger
        title="Trocar a chave RTMP"
        confirmLabel="Trocar chave"
        message={
          <>
            A chave atual de <b>{camera.code}</b> deixa de funcionar na hora e a câmera é
            desconectada. Será preciso configurar a chave nova no equipamento.
          </>
        }
        onClose={() => setRotating(false)}
        onConfirm={async () => {
          try {
            setIngest(await api.post<Ingest>(`/cameras/${camera.id}/rotate-key`));
            toast("Chave trocada. Configure a nova chave na câmera.");
            onChanged();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </Drawer>
  );
}

// ------------------------------------------------------------------ página
interface TenantSummary {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  total: number;
  online: number;
  recording: number;
  offline: number;
  matching: number;
}

/** Câmeras de um cliente, abertas abaixo da linha dele (tela Câmeras agrupada). */
function TenantCameras({
  tenantId,
  query,
  refreshKey,
  render,
  onAll,
}: {
  tenantId: string;
  query: { search: string; locationId: string; groupId: string; status: string };
  refreshKey: number;
  render: (rows: Camera[]) => React.ReactNode;
  onAll: () => void;
}) {
  const [data, setData] = useState<Page<Camera> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { search, locationId, groupId, status } = query;
  useEffect(() => {
    let stop = false;
    api
      .get<Page<Camera>>(
        `/cameras${qs({ tenantId, search, locationId, groupId, status, pageSize: 100 })}`,
      )
      .then((r) => !stop && (setData(r), setError(null)))
      .catch((err) => !stop && setError(err));
    return () => {
      stop = true;
    };
  }, [tenantId, search, locationId, groupId, status, refreshKey]);
  if (error) return <ErrorBox error={error} />;
  if (!data)
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Carregando…
      </div>
    );
  return (
    <div className="-mx-4 -my-3 bg-white" data-testid={`tenant-cameras-${tenantId}`}>
      {render(data.items)}
      {data.total > data.items.length && (
        <div className="border-t border-line px-4 py-2 text-xs">
          Mostrando {data.items.length} de {data.total}.{" "}
          <button className="font-medium text-brand-600 hover:underline" onClick={onAll}>
            Ver todas deste cliente
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ transferência
function TransferModal({
  camera,
  locations,
  tenants,
  onClose,
  onDone,
}: {
  camera: Camera | null;
  locations: Loc[];
  tenants: { id: string; name: string }[];
  onClose: () => void;
  onDone: (moved: Camera, ingest?: Ingest) => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [keepKey, setKeepKey] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!camera) return;
    setTenantId("");
    setLocationId("");
    setGroupId("");
    setKeepKey(true);
    setConfirm(false);
    setError(null);
  }, [camera]);

  const targets = tenants.filter((t) => t.id !== camera?.tenantId);
  const locs = locations.filter((l) => l.tenantId === tenantId);
  const groups = locs.find((l) => l.id === locationId)?.groups ?? [];
  const targetName = tenants.find((t) => t.id === tenantId)?.name ?? "";

  async function transfer() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ camera: Camera; ingest?: Ingest }>(
        `/cameras/${camera!.id}/transfer`,
        { tenantId, locationId, groupId: groupId || null, keepKey },
      );
      onDone(r.camera, r.ingest);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!camera}
      title={camera ? `Transferir ${camera.code} para outro cliente` : ""}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-primary"
            onClick={transfer}
            disabled={busy || !tenantId || !locationId || !confirm}
          >
            {busy && <Loader2 size={16} className="animate-spin" />} Transferir
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="space-y-3" data-testid="transfer">
        <p className="text-sm text-slate-700">
          <b>{camera?.name}</b> sai de <b>{camera?.tenantName}</b> e passa a ser uma câmera nova no
          cliente de destino, com o próximo código dele.
        </p>
        <Field label="Cliente de destino *">
          <select
            className="input"
            value={tenantId}
            onChange={(e) => (setTenantId(e.target.value), setLocationId(""), setGroupId(""))}
          >
            <option value="">Selecione…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Local no destino *"
            hint={
              tenantId && locs.length === 0
                ? "Esse cliente não tem locais: cadastre em Grupos / Locais."
                : undefined
            }
          >
            <select
              className="input"
              value={locationId}
              disabled={!tenantId}
              onChange={(e) => (setLocationId(e.target.value), setGroupId(""))}
            >
              <option value="">Selecione…</option>
              {locs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grupo no destino">
            <select
              className="input"
              value={groupId}
              disabled={!locationId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">Sem grupo</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset className="space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 text-xs font-medium text-muted">Chave RTMP</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="key"
              className="mt-0.5"
              checked={keepKey}
              onChange={() => setKeepKey(true)}
            />
            <span>
              Manter a chave atual
              <span className="block text-xs text-muted">
                O mesmo equipamento continua transmitindo, sem reconfigurar.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="key"
              className="mt-0.5"
              checked={!keepKey}
              onChange={() => setKeepKey(false)}
            />
            <span>
              Gerar nova chave
              <span className="block text-xs text-muted">
                A chave atual deixa de valer; o equipamento precisa ser reconfigurado.
              </span>
            </span>
          </label>
        </fieldset>
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          As gravações, eventos e relatórios desta câmera <b>não vão para o cliente novo</b>: ficam
          guardados em {camera?.tenantName}, saem do painel (como numa câmera excluída) e são
          apagados pela retenção. Os usuários de {camera?.tenantName} perdem o acesso a ela.
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          Confirmo a transferência{targetName ? ` para ${targetName}` : ""}
        </label>
      </div>
    </Modal>
  );
}

function CamerasPage() {
  const auth = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const canWrite = auth.can("cameras.write");
  const [data, setData] = useState<Page<Camera> | null>(null);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [retention, setRetention] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [tenantId, setTenantId] = useState("");
  const [place, setPlace] = useState("");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [viewing, setViewing] = useState<Camera | null>(null);
  const [created, setCreated] = useState<Ingest | null>(null);
  const [deleting, setDeleting] = useState<Camera | null>(null);
  const [toggling, setToggling] = useState<Camera | null>(null);
  const [transferring, setTransferring] = useState<Camera | null>(null);
  // Equipe da plataforma sem cliente escolhido: câmeras agrupadas por cliente.
  const grouped = auth.isPlatform && !tenantId;
  const [summary, setSummary] = useState<{ filtered: boolean; items: TenantSummary[] } | null>(
    null,
  );
  const [openTenants, setOpenTenants] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const appliedFilter = useRef<string | null>(null);

  const [locationId, groupId] = place.startsWith("g:")
    ? ["", place.slice(2)]
    : [place.startsWith("l:") ? place.slice(2) : "", ""];

  const load = useCallback(async () => {
    try {
      setError(null);
      if (grouped) {
        const r = await api.get<{ filtered: boolean; items: TenantSummary[] }>(
          `/cameras/summary${qs({ search, locationId, groupId, status })}`,
        );
        setSummary(r);
        setRefreshKey((k) => k + 1);
        // Pesquisa ou filtro novo: os clientes com resultado já abrem; sem filtro, fechados.
        const key = `${search}|${locationId}|${groupId}|${status}`;
        if (appliedFilter.current !== key) {
          appliedFilter.current = key;
          setOpenTenants(r.filtered ? new Set(r.items.map((t) => t.tenantId)) : new Set<string>());
        }
      } else {
        setData(
          await api.get<Page<Camera>>(
            `/cameras${qs({ search, tenantId, locationId, groupId, status, page, pageSize: 10 })}`,
          ),
        );
      }
    } catch (err) {
      setError(err);
    }
  }, [grouped, search, tenantId, locationId, groupId, status, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Atualiza o estado das câmeras periodicamente.
  useEffect(() => {
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    api
      .get<{ items: Loc[] }>("/locations")
      .then((r) => setLocations(r.items))
      .catch(() => undefined);
    api
      .get<{ retentionPolicies: { id: string; name: string }[] }>("/meta")
      .then((m) => setRetention(m.retentionPolicies))
      .catch(() => undefined);
    if (auth.isPlatform)
      api
        .get<Page<{ id: string; name: string }>>("/tenants?pageSize=100")
        .then((r) => setTenants(r.items))
        .catch(() => undefined);
  }, [auth.isPlatform]);

  const placeOptions = useMemo(
    () => locations.filter((l) => !tenantId || l.tenantId === tenantId),
    [locations, tenantId],
  );

  async function exportCsv() {
    // Exporta todas as câmeras que atendem aos filtros (não só a página na tela).
    const all: Camera[] = [];
    for (let p = 1; ; p++) {
      const r = await api.get<Page<Camera>>(
        `/cameras${qs({ search, tenantId, locationId, groupId, status, page: p, pageSize: 100 })}`,
      );
      all.push(...r.items);
      if (p >= r.pages) break;
    }
    const head = [
      "Código",
      "Nome",
      "Cliente",
      "Local",
      "Grupo",
      "Protocolo",
      "Resolução",
      "FPS",
      "Bitrate (kbps)",
      "Status",
      "Último vídeo",
    ];
    const lines = all.map((c) =>
      [
        c.code,
        c.name,
        c.tenantName,
        c.locationName,
        c.groupName ?? "",
        "RTMP",
        c.width ? `${c.width}x${c.height}` : "",
        c.fps ?? "",
        c.bitrateKbps ?? "",
        CAMERA_STATUS[c.status]?.label ?? c.status,
        c.lastVideoAt ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(";"),
    );
    const blob = new Blob([`\uFEFF${[head.join(";"), ...lines].join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cameras.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const columns: Column<Camera>[] = [
    {
      key: "code",
      header: "ID",
      cell: (c) => <span className="font-mono text-xs">{c.code}</span>,
      mobileHidden: true,
    },
    { key: "name", header: "Nome", cell: (c) => c.name, mobileHidden: true },
    ...(auth.isPlatform
      ? [{ key: "tenant", header: "Cliente", cell: (c: Camera) => c.tenantName }]
      : []),
    { key: "place", header: "Grupo / Local", cell: (c) => c.groupName ?? c.locationName },
    { key: "proto", header: "Protocolo", cell: () => "RTMP", mobileHidden: true },
    { key: "res", header: "Resolução", cell: (c) => (c.width ? `${c.width}x${c.height}` : "—") },
    {
      key: "fps",
      header: "FPS",
      cell: (c) => (c.fps ? Math.round(c.fps) : "—"),
      mobileHidden: true,
    },
    {
      key: "bitrate",
      header: "Bitrate",
      cell: (c) =>
        c.bitrateKbps ? `${(c.bitrateKbps / 1000).toFixed(1).replace(".", ",")} Mbps` : "—",
    },
    { key: "status", header: "Status", cell: (c) => <StatusCell c={c} /> },
    {
      key: "last",
      header: "Último Contato",
      cell: (c) =>
        c.status === "ao_vivo" || c.status === "gravando"
          ? "Online agora"
          : fmtRelative(c.lastVideoAt),
    },
  ];

  const actions = (c: Camera) => (
    <>
      {c.enabled && (
        <Link
          className="icon-btn"
          title="Ao vivo"
          aria-label={`Ao vivo ${c.code}`}
          href={`/ao-vivo?camera=${c.id}`}
        >
          <MonitorPlay size={16} />
        </Link>
      )}
      <button
        className="icon-btn"
        title="Detalhes"
        aria-label={`Detalhes de ${c.code}`}
        onClick={() => setViewing(c)}
      >
        <Eye size={16} />
      </button>
      {canWrite && (
        <>
          <button
            className="icon-btn"
            title="Editar"
            aria-label={`Editar ${c.code}`}
            onClick={() => (setEditing(c), setFormOpen(true))}
          >
            <Pencil size={16} />
          </button>
          <button
            className="icon-btn"
            title={c.enabled ? "Desativar" : "Ativar"}
            aria-label={`${c.enabled ? "Desativar" : "Ativar"} ${c.code}`}
            onClick={() => setToggling(c)}
          >
            <Power size={16} className={c.enabled ? "" : "text-red-500"} />
          </button>
          <button
            className="icon-btn hover:!text-red-600"
            title="Excluir"
            aria-label={`Excluir ${c.code}`}
            onClick={() => setDeleting(c)}
          >
            <Trash2 size={16} />
          </button>
        </>
      )}
    </>
  );

  const cameraTable = (rows: Camera[], cols: Column<Camera>[]) => (
    <DataTable
      rows={rows}
      columns={cols}
      rowKey={(c) => c.id}
      mobileTitle={(c) => (
        <span>
          <span className="mr-2 font-mono text-xs text-slate-500">{c.code}</span>
          {c.name}
        </span>
      )}
      actions={actions}
    />
  );

  const toggleTenant = (id: string) =>
    setOpenTenants((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const summaryColumns: Column<TenantSummary>[] = [
    {
      key: "tenant",
      header: "Cliente",
      cell: (t) => (
        <button
          className="inline-flex items-center gap-1.5 text-left font-medium hover:text-brand-600"
          aria-expanded={openTenants.has(t.tenantId)}
          aria-label={`Câmeras de ${t.tenantName}`}
          onClick={() => toggleTenant(t.tenantId)}
        >
          {openTenants.has(t.tenantId) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {t.tenantName}
          {t.tenantStatus !== "active" && (
            <span className="text-xs font-normal text-muted">
              ({TENANT_STATUS[t.tenantStatus]?.label ?? t.tenantStatus})
            </span>
          )}
        </button>
      ),
    },
    {
      key: "total",
      header: "Câmeras",
      cell: (t) =>
        summary?.filtered && t.matching !== t.total ? `${t.matching} de ${t.total}` : t.total,
    },
    {
      key: "online",
      header: "No ar",
      cell: (t) => <span className="text-green-700">{t.online}</span>,
    },
    { key: "recording", header: "Gravando", cell: (t) => t.recording },
    {
      key: "offline",
      header: "Offline",
      cell: (t) =>
        t.offline > 0 ? (
          <Badge tone="red" dot>
            {t.offline}
          </Badge>
        ) : (
          <span className="text-muted">0</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Câmeras"
        subtitle="Gerencie as câmeras cadastradas no sistema."
        actions={
          <>
            <button
              className="btn-secondary"
              onClick={() => void exportCsv().catch(setError)}
              disabled={grouped ? !summary?.items.length : !data?.items.length}
            >
              <Download size={16} /> Exportar
            </button>
            {canWrite && (
              <button className="btn-primary" onClick={() => (setEditing(null), setFormOpen(true))}>
                <Plus size={16} /> Nova Câmera
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-line p-4 xl:flex-row xl:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pl-9 xl:max-w-sm"
              placeholder="Pesquisar câmera…"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:flex">
            {auth.isPlatform && (
              <select
                className="input h-9 xl:w-44"
                aria-label="Cliente"
                value={tenantId}
                onChange={(e) => (setTenantId(e.target.value), setPlace(""), setPage(1))}
              >
                <option value="">Cliente: Todos</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <select
              className="input h-9 xl:w-48"
              aria-label="Grupo"
              value={place}
              onChange={(e) => (setPlace(e.target.value), setPage(1))}
            >
              <option value="">Grupo: Todos</option>
              {placeOptions.map((l) => (
                <optgroup
                  key={l.id}
                  label={auth.isPlatform ? `${l.tenantName} › ${l.name}` : l.name}
                >
                  <option value={`l:${l.id}`}>{l.name} (local inteiro)</option>
                  {l.groups.map((g) => (
                    <option key={g.id} value={`g:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              className="input h-9 xl:w-40"
              aria-label="Status"
              value={status}
              onChange={(e) => (setStatus(e.target.value), setPage(1))}
            >
              <option value="">Status: Todos</option>
              {Object.entries(CAMERA_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {grouped ? (
          !summary ? (
            <Loading />
          ) : summary.items.length === 0 ? (
            <Empty
              icon={<CameraIcon size={40} />}
              title="Nenhuma câmera encontrada"
              text={
                canWrite
                  ? "Ajuste os filtros ou cadastre uma nova câmera."
                  : "Nenhuma câmera foi liberada para você ainda."
              }
            />
          ) : (
            <DataTable
              rows={summary.items}
              columns={summaryColumns}
              rowKey={(t) => t.tenantId}
              mobileTitle={(t) => t.tenantName}
              expanded={(t) =>
                openTenants.has(t.tenantId) ? (
                  <TenantCameras
                    tenantId={t.tenantId}
                    query={{ search, locationId, groupId, status }}
                    refreshKey={refreshKey}
                    render={(rows) =>
                      cameraTable(
                        rows,
                        columns.filter((c) => c.key !== "tenant"),
                      )
                    }
                    onAll={() => (setTenantId(t.tenantId), setPage(1))}
                  />
                ) : null
              }
            />
          )
        ) : !data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty
            icon={<CameraIcon size={40} />}
            title="Nenhuma câmera encontrada"
            text={
              canWrite
                ? "Ajuste os filtros ou cadastre uma nova câmera."
                : "Nenhuma câmera foi liberada para você ainda."
            }
          />
        ) : (
          <>
            {cameraTable(data.items, columns)}
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.pageSize}
              onPage={setPage}
            />
          </>
        )}
      </div>

      <CameraForm
        open={formOpen}
        camera={editing}
        locations={locations}
        tenants={auth.isPlatform ? tenants : auth.user?.tenant ? [auth.user.tenant] : []}
        retention={retention}
        onClose={() => setFormOpen(false)}
        onSaved={(ingest) => {
          void load();
          if (ingest) setCreated(ingest);
          else toast("Câmera atualizada");
        }}
        onTransfer={
          auth.can("cameras.keys") ? (c) => (setFormOpen(false), setTransferring(c)) : undefined
        }
      />
      <TransferModal
        camera={transferring}
        locations={locations}
        tenants={tenants}
        onClose={() => setTransferring(null)}
        onDone={(moved, ingest) => {
          void load();
          toast(`Câmera transferida: agora ${moved.code} em ${moved.tenantName}`);
          if (ingest) setCreated(ingest);
        }}
      />
      <CameraDrawer camera={viewing} onClose={() => setViewing(null)} onChanged={load} />

      <Modal
        open={!!created}
        title="Câmera cadastrada"
        onClose={() => setCreated(null)}
        footer={
          <button className="btn-primary" onClick={() => setCreated(null)}>
            Concluir
          </button>
        }
      >
        {created && (
          <IngestBox
            ingest={created}
            title="Configure estes dados na câmera (opção RTMP / Live / Streaming). Eles podem ser consultados de novo nos detalhes da câmera."
          />
        )}
      </Modal>

      <Confirm
        open={!!toggling}
        danger={toggling?.enabled}
        title={toggling?.enabled ? "Desativar câmera" : "Ativar câmera"}
        confirmLabel={toggling?.enabled ? "Desativar" : "Ativar"}
        message={
          toggling?.enabled ? (
            <>
              A câmera <b>{toggling?.code}</b> deixa de ser aceita e é desconectada. A chave
              continua a mesma.
            </>
          ) : (
            <>
              Voltar a aceitar a câmera <b>{toggling?.code}</b>?
            </>
          )
        }
        onClose={() => setToggling(null)}
        onConfirm={async () => {
          try {
            await api.patch(`/cameras/${toggling!.id}`, { enabled: !toggling!.enabled });
            toast(toggling!.enabled ? "Câmera desativada" : "Câmera ativada");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
      <Confirm
        open={!!deleting}
        danger
        title="Excluir câmera"
        confirmLabel="Excluir"
        message={
          <>
            Excluir{" "}
            <b>
              {deleting?.code} · {deleting?.name}
            </b>
            ? A câmera é desconectada e some das listas; o histórico e a auditoria são mantidos.
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(`/cameras/${deleting!.id}`);
            toast("Câmera excluída");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <CamerasPage />
    </Suspense>
  );
}
