-- TopCam — Fase 8: redes liberadas para o SSH (firewall do host).
--
-- O painel só grava a lista desejada. Quem aplica é o serviço do host
-- (scripts/host/topcam-host, fora do Docker), que lê esta tabela, valida de novo e
-- aplica as regras nftables de uma vez; o resultado volta em system_settings
-- ("firewall.status"). Nenhum contêiner tem permissão sobre o firewall.

CREATE TABLE IF NOT EXISTS firewall_ssh_networks (
  id          bigserial PRIMARY KEY,
  cidr        cidr NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Nada de "a internet inteira": no mínimo /8 em IPv4 e /16 em IPv6.
  CHECK ((family(cidr) = 4 AND masklen(cidr) >= 8) OR (family(cidr) = 6 AND masklen(cidr) >= 16))
);
ALTER TABLE firewall_ssh_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON firewall_ssh_networks;
CREATE POLICY platform_only ON firewall_ssh_networks
  USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON firewall_ssh_networks TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE firewall_ssh_networks_id_seq TO topcam_app;
