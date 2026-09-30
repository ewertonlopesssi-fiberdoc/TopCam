# Fase 8 — roteiro dos testes de resiliência

Três frentes. Nenhuma exige mudar código.

1. **VM limpa temporária** (pode ser apagada no fim): instalar do zero, restaurar um backup
   de produção, encher o disco do sistema e reiniciar.
2. **Produção (VM 107):** aceite da Fase 8 e reinício da VM, em horário tranquilo.
3. **Teste contínuo de 7 dias** e relatório.

Por último: troca dos segredos (`scripts/rotate-secrets.sh --all`) e fechamento da Fase 8.

---

## 1. VM limpa temporária

### 1.1 Criar a VM (Proxmox)

| Item | Valor |
|---|---|
| Sistema | Debian 12 (o mesmo ISO: `debian-12.11.0-amd64-netinst.iso`) |
| CPU / memória | 2 vCPU / 4 GB |
| Disco | **um só**, 25 GB, no **HD18-TB** (sem disco de vídeo: as gravações vão para o disco do sistema, o que é justamente o que o teste de disco cheio precisa) |
| Rede | a mesma ponte da VM 107, com um IP livre da 172.31.141.0/24 (exemplo: 172.31.141.21) |
| Instalação | só "servidor SSH" e "utilitários padrão do sistema" |

Nos passos abaixo, `IP-TESTE` é o IP escolhido.

### 1.2 Levar o código da produção para a VM de teste

Assim não é preciso credencial do GitHub. **Na VM 107:**

```
cd /opt/topcam && git bundle create /root/topcam-completo.bundle --all
scp /root/topcam-completo.bundle root@IP-TESTE:/root/
```

**Na VM de teste:**

```
apt-get update && apt-get install -y git
git clone /root/topcam-completo.bundle /opt/topcam && cd /opt/topcam
infra/vm/prepare-vm.sh
scripts/generate-env.sh --public-host IP-TESTE --admin-email teste@topcam.local
docker compose up -d --build
```

- O `prepare-vm.sh` instala o Docker. Ele avisa que não há disco de vídeo; neste teste isso é esperado.
- A primeira construção leva de 20 a 40 minutos.

### 1.3 Restaurar um backup da produção

1. Faça o backup. **No painel da produção:** Configurações → Integrações → Backup → "Fazer backup agora".
2. Copie o arquivo para a VM de teste. Pode ser pelo botão de baixar do histórico, ou direto **da VM 107:**

   ```
   scp /opt/topcam/.data/backups/topcam-AAAAMMDD-HHMMSS.tar.gpg root@IP-TESTE:/root/
   ```

3. Restaure. **Na VM de teste:**

   ```
   cd /opt/topcam && scripts/restore.sh --file /root/topcam-AAAAMMDD-HHMMSS.tar.gpg --public-host IP-TESTE
   ```

   O script pede a senha do backup e a confirmação `RESTAURAR`.

O `--public-host` deixa a VM de teste com o painel em HTTP nesse IP e com o **backup automático desligado**. Assim ela nunca grava nem apaga arquivos no destino da produção.

**Conferir no navegador** (`http://IP-TESTE`, entrando com o usuário e a senha da **produção**):

- [ ] Clientes, usuários e câmeras com as mesmas quantidades da produção
- [ ] Câmeras → uma câmera → **ver a chave RTMP** (prova que a chave de cifra veio junto)
- [ ] Eventos e alertas com o histórico
- [ ] Configurações → Firewall com as 4 redes (na VM de teste o firewall não é instalado; é só o cadastro)
- [ ] Configurações → Backup: automático **desligado**

E no terminal:

```
docker compose exec -T api node apps/api/dist/cli.js secrets:check
```

O esperado é "chaves de câmera legíveis: N; ilegíveis: 0".

### 1.4 Disco do sistema cheio (só na VM de teste)

```
cd /opt/topcam && scripts/test-disk-full.sh --vm-de-teste
```

- Pede que se digite `ENCHER`.
- Leva de 15 a 20 minutos.
- Recusa rodar se o painel estiver com domínio, que é o caso da produção.

O que acontece:

- enche o disco até 90% (deve abrir o alerta);
- enche até 100% e segura 3 minutos (é esperado degradar);
- apaga o arquivo e confere que **tudo volta sozinho**: serviços, banco gravando, gravação da CAM-001 de teste, nada fora do índice, banco íntegro (`pg_amcheck`) e alerta fechado.

Relatório: `reports/disco-cheio-*.md`.

### 1.5 Reinício (ensaio na VM de teste)

```
scripts/accept-phase8.sh --before-reboot
reboot
# depois de uns 2 minutos, entrar de novo:
cd /opt/topcam && scripts/accept-phase8.sh --after-reboot
```

Relatório: `reports/phase8-reboot-*.md`.

### 1.6 Fim

Me mande os relatórios (`cat reports/disco-cheio-*.md reports/phase8-reboot-*.md`) e a lista conferida do item 1.3. Depois disso a VM de teste pode ser apagada.

---

## 2. Produção (VM 107)

### 2.1 Aceite da Fase 8

O item R1 reinicia os contêineres um por um. A TWG fica com lacunas curtas (segundos por reinício, cerca de 2 minutos no total). Rode num horário tranquilo, ou use `--skip-restart`: o R1 já terá sido feito na VM de teste.

A senha do backup vai num arquivo temporário, só para o root, apagado no fim:

```
cd /opt/topcam
(umask 077; read -r -s -p "Senha do backup: " P; echo; printf '%s' "$P" > /root/.senha-backup)
nohup scripts/accept-phase8.sh --passphrase-file /root/.senha-backup > /root/aceite8.log 2>&1 &
```

Quando terminar (`tail -3 /root/aceite8.log` mostra o total): `rm /root/.senha-backup`.

### 2.2 Reinício da VM

Em horário tranquilo:

```
cd /opt/topcam && scripts/accept-phase8.sh --before-reboot
reboot
# depois de uns 2 minutos:
cd /opt/topcam && scripts/accept-phase8.sh --after-reboot
```

**Se o SSH não voltar:** use o console do Proxmox e rode `topcam-host status`. Se precisar, `topcam-host reset`.

---

## 3. Teste contínuo de 7 dias

- **Início:** depois de aplicar esta parte e fazer os testes da produção. Anote a data e a hora.
- **Durante os 7 dias:** nada de atualizações nem reinícios manuais, a não ser correções urgentes. Se houver, anote.
- **No 7º dia:**

  ```
  cd /opt/topcam && scripts/report-7days.sh --since "AAAA-MM-DD HH:MM"
  ```

  Use a data e a hora do início. O relatório sai em `reports/relatorio-continuo-*.md`.
- **Prévia a qualquer momento:** `scripts/report-7days.sh --days 1`.

**O que o relatório mostra:**

- serviços e reinícios;
- disponibilidade de cada câmera;
- cobertura e lacunas da gravação contínua;
- alertas;
- backups;
- disco de vídeo (uso e latência de escrita);
- CPU, memória e E/S travada (o sinal dos travamentos do disco);
- uma lista de pontos de atenção.

Gere o relatório no fim do período: as amostras e métricas com mais de 7 dias são descartadas.
