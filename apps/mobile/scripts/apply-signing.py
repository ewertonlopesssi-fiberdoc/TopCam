#!/usr/bin/env python3
"""Assina o APK de release com a chave oficial (upload key) em vez da de depuração.

Roda depois do `expo prebuild` (o projeto android/ é gerado a cada build). As senhas NÃO
são gravadas em arquivo: o Gradle lê das variáveis de ambiente na hora do build.

  TOPCAM_KEYSTORE           caminho do topcam-upload.p12
  TOPCAM_KEYSTORE_PASSWORD  senha do keystore
  TOPCAM_KEY_ALIAS          alias (padrão: topcam-upload)
  TOPCAM_KEY_PASSWORD       senha da chave (padrão: a do keystore)
"""
import os
import sys

path = os.path.join(os.path.dirname(__file__), "..", "android", "app", "build.gradle")
if not os.environ.get("TOPCAM_KEYSTORE") or not os.environ.get("TOPCAM_KEYSTORE_PASSWORD"):
    sys.exit("defina TOPCAM_KEYSTORE e TOPCAM_KEYSTORE_PASSWORD")
if not os.path.isfile(os.environ["TOPCAM_KEYSTORE"]):
    sys.exit(f"keystore não encontrado: {os.environ['TOPCAM_KEYSTORE']}")
s = open(path, encoding="utf-8").read()
release_cfg = """    signingConfigs {
        release {
            storeFile file(System.getenv("TOPCAM_KEYSTORE"))
            storeType "pkcs12"
            storePassword System.getenv("TOPCAM_KEYSTORE_PASSWORD")
            keyAlias System.getenv("TOPCAM_KEY_ALIAS") ?: "topcam-upload"
            keyPassword System.getenv("TOPCAM_KEY_PASSWORD") ?: System.getenv("TOPCAM_KEYSTORE_PASSWORD")
        }
"""
if "TOPCAM_KEYSTORE" not in s:
    assert s.count("    signingConfigs {\n") == 1, "signingConfigs não encontrado"
    s = s.replace("    signingConfigs {\n", release_cfg, 1)
    marker = "            // see https://reactnative.dev/docs/signed-apk-android.\n            signingConfig signingConfigs.debug\n"
    assert s.count(marker) == 1, "assinatura do release não encontrada"
    s = s.replace(marker, marker.replace("signingConfigs.debug", "signingConfigs.release"), 1)
    open(path, "w", encoding="utf-8").write(s)
print("APK de release será assinado com a chave oficial (alias "
      + os.environ.get("TOPCAM_KEY_ALIAS", "topcam-upload") + ")")
