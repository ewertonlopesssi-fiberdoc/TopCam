-- TopCam — envio dos dados de acesso por e-mail (cadastro de usuários).
-- O registro de envios passa a aceitar o tipo "access". A senha nunca é gravada:
-- só destinatário, assunto e resultado.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('alert', 'resolved', 'test', 'digest', 'access'));
