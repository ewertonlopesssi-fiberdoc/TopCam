#!/usr/bin/env bash
# TopCam — preparação da VM Debian (12 ou 13) no Proxmox.
#
# O que faz (idempotente):
#   1. instala Docker Engine + Compose (repositório oficial da Docker);
#   2. limita logs do Docker e do journald;
#   3. formata (só com confirmação) e monta o disco de vídeo em /srv/topcam/recordings;
#   4. opcional: firewall nftables para os serviços do host (SSH só da rede de administração).
#
# Uso (como root):
#   ./prepare-vm.sh --video-disk /dev/sdb [--firewall --admin-cidr 192.168.10.0/24] [--skip-docker]
#
# Segurança do disco: o script SE RECUSA a formatar um disco que tenha partições ou
# sistema de arquivos, a menos que seja o próprio disco de vídeo do TopCam (rótulo
# topcam-video) — nesse caso apenas monta. Para forçar: --force-format (APAGA TUDO).

set -euo pipefail

VIDEO_DISK=""
FORCE_FORMAT=0
FIREWALL=0
SKIP_DOCKER=0
ADMIN_CIDR=""
MOUNT_POINT=/srv/topcam/recordings
LABEL=topcam-video

while [ $# -gt 0 ]; do
  case "$1" in
    --video-disk) VIDEO_DISK="$2"; shift 2 ;;
    --force-format) FORCE_FORMAT=1; shift ;;
    --firewall) FIREWALL=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --admin-cidr) ADMIN_CIDR="$2"; shift 2 ;;
    --mount-point) MOUNT_POINT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[topcam]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[topcam] ERRO:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "execute como root"
. /etc/os-release
[ "${ID:-}" = "debian" ] || die "este script é para Debian (encontrado: ${ID:-?})"
log "Debian ${VERSION_ID:-?} (${VERSION_CODENAME:-?})"

# ------------------------------------------------------------------ 1. pacotes + Docker
if [ "$SKIP_DOCKER" -eq 1 ]; then
  log "--skip-docker: pulando instalação e ajustes do Docker/journald"
elif ! command -v docker >/dev/null 2>&1; then
  log "instalando Docker Engine e Compose"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg nftables e2fsprogs openssl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
else
  log "Docker já instalado: $(docker --version)"
fi
[ "$SKIP_DOCKER" -eq 1 ] || systemctl enable --now docker >/dev/null

# ------------------------------------------------------------------ 2. limites de log
if [ "$SKIP_DOCKER" -eq 0 ] && [ ! -f /etc/docker/daemon.json ]; then
  log "limitando logs do Docker (10 MB x 5 por contêiner)"
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
  systemctl restart docker
fi
if [ "$SKIP_DOCKER" -eq 0 ]; then
  mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/topcam.conf
  systemctl restart systemd-journald || true
fi

# ------------------------------------------------------------------ 3. disco de vídeo
if [ -n "$VIDEO_DISK" ]; then
  [ -b "$VIDEO_DISK" ] || die "$VIDEO_DISK não é um dispositivo de bloco"
  case "$(lsblk -dno TYPE "$VIDEO_DISK")" in
    disk|loop) ;;  # loop só é usado nos testes do script
    *) die "$VIDEO_DISK não é um disco inteiro" ;;
  esac
  command -v mkfs.ext4 >/dev/null 2>&1 || { log "instalando e2fsprogs"; apt-get install -y -qq e2fsprogs >/dev/null; }
  ROOT_SRC=$(findmnt -no SOURCE /)
  case "$ROOT_SRC" in "$VIDEO_DISK"*) die "$VIDEO_DISK contém o sistema (/). Abortando." ;; esac
  if lsblk -no MOUNTPOINT "$VIDEO_DISK" | grep -q .; then
    CUR=$(lsblk -no MOUNTPOINT "$VIDEO_DISK" | grep . | head -1)
    [ "$CUR" = "$MOUNT_POINT" ] || die "$VIDEO_DISK já está montado em $CUR"
    log "$VIDEO_DISK já montado em $MOUNT_POINT"
  else
    FSTYPE=$(blkid -o value -s TYPE "$VIDEO_DISK" 2>/dev/null || true)
    FSLABEL=$(blkid -o value -s LABEL "$VIDEO_DISK" 2>/dev/null || true)
    PARTS=$(lsblk -no NAME "$VIDEO_DISK" | tail -n +2 | wc -l)
    if [ "$FSTYPE" = "ext4" ] && [ "$FSLABEL" = "$LABEL" ]; then
      log "disco de vídeo do TopCam já formatado; apenas montando"
    elif [ -n "$FSTYPE" ] || [ "$PARTS" -gt 0 ]; then
      [ "$FORCE_FORMAT" -eq 1 ] || die "$VIDEO_DISK já tem dados (fs='${FSTYPE:-}', partições=$PARTS). Confira o disco; para apagar use --force-format."
      log "--force-format: APAGANDO $VIDEO_DISK"
      wipefs -a "$VIDEO_DISK" >/dev/null
      mkfs.ext4 -q -F -L "$LABEL" -m 0 "$VIDEO_DISK"
    else
      log "formatando $VIDEO_DISK (ext4, rótulo $LABEL)"
      mkfs.ext4 -q -L "$LABEL" -m 0 "$VIDEO_DISK"
    fi
    mkdir -p "$MOUNT_POINT"
    UUID=$(blkid -o value -s UUID "$VIDEO_DISK")
    if ! grep -q "^UUID=$UUID " /etc/fstab; then
      # Remove entradas antigas deste ponto de montagem (ex.: disco reformatado) e grava a nova.
      cp /etc/fstab "/etc/fstab.topcam.$(date +%Y%m%d%H%M%S).bak"
      awk -v mp="$MOUNT_POINT" '$2 != mp' /etc/fstab > /etc/fstab.new && mv /etc/fstab.new /etc/fstab
      echo "UUID=$UUID $MOUNT_POINT ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
    fi
    systemctl daemon-reload 2>/dev/null || true
    mount "$MOUNT_POINT"
    [ "$(findmnt -no SOURCE "$MOUNT_POINT")" = "$VIDEO_DISK" ] || die "falha ao montar $VIDEO_DISK em $MOUNT_POINT"
    log "disco de vídeo montado em $MOUNT_POINT ($(df -h --output=size "$MOUNT_POINT" | tail -1 | tr -d ' '))"
  fi
  chmod 0755 "$MOUNT_POINT"
else
  log "nenhum --video-disk informado: gravações ficarão no disco do sistema (não recomendado)"
  mkdir -p "$MOUNT_POINT"
fi

# ------------------------------------------------------------------ 4. firewall do host (opcional)
if [ "$FIREWALL" -eq 1 ]; then
  [ -n "$ADMIN_CIDR" ] || die "--firewall exige --admin-cidr (rede de onde você administra por SSH)"
  log "aplicando nftables: SSH só de $ADMIN_CIDR; 80/443/1935/1936 abertos"
  cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# TopCam — firewall do host. As portas publicadas pelo Docker são tratadas
# pela cadeia FORWARD do próprio Docker; restrinja-as também no firewall do Proxmox.
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    meta l4proto { icmp, ipv6-icmp } accept
    ip saddr $ADMIN_CIDR tcp dport 22 accept
    tcp dport { 80, 443, 1935, 1936 } accept
  }
  chain forward { type filter hook forward priority 0; policy accept; }
  chain output { type filter hook output priority 0; policy accept; }
}
EOF
  systemctl enable --now nftables >/dev/null
  nft -f /etc/nftables.conf
  systemctl restart docker   # recria as regras do Docker após o flush
fi

log "pronto. Próximos passos:"
log "  1) git clone <repositório> /opt/topcam && cd /opt/topcam"
log "  2) scripts/generate-env.sh --public-host video.seudominio.com.br --admin-email voce@dominio"
log "  3) docker compose up -d --build"
log "  4) scripts/accept-phase1.sh   (teste de aceite com o transmissor de teste)"
