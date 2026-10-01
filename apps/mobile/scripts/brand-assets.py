#!/usr/bin/env python3
"""
Gera os ícones e a tela de abertura de uma marca (white label).

    python3 scripts/brand-assets.py [marca]      # padrão: topcam

Entrada: brands/<marca>/brand.json e, se existir, brands/<marca>/logo.png (quadrado, fundo
transparente, de preferência 1024×1024). Sem logo, desenha um provisório (escudo com lente)
na cor da marca.

Saída em brands/<marca>/generated/:
    icon.png                 1024×1024 (iPhone e loja)
    adaptive-foreground.png  1024×1024 (Android: logo dentro da área segura de 66%)
    adaptive-monochrome.png  1024×1024 (Android 13+: ícone temático)
    splash.png               1024×1024 (logo da tela de abertura)
    favicon.png              48×48
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
brand_id = sys.argv[1] if len(sys.argv) > 1 else "topcam"
bdir = ROOT / "brands" / brand_id
brand = json.loads((bdir / "brand.json").read_text(encoding="utf-8"))
out = bdir / "generated"
out.mkdir(exist_ok=True)
S = 1024


def hex_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


PRIMARY = hex_rgb(brand["primaryColor"])


def provisional_logo(color=(255, 255, 255, 255), size=S) -> Image.Image:
    """Escudo com uma lente de câmera no meio (lembra o ícone do painel)."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = size / 1024
    shield = [(512, 150), (800, 260), (790, 560), (512, 880), (234, 560), (224, 260)]
    d.polygon([(x * k, y * k) for x, y in shield], fill=color)
    hole = (0, 0, 0, 0)
    d.ellipse([382 * k, 360 * k, 642 * k, 620 * k], fill=hole)
    d.ellipse([432 * k, 410 * k, 592 * k, 570 * k], fill=color)
    d.ellipse([470 * k, 448 * k, 520 * k, 498 * k], fill=hole)
    return im


logo_file = bdir / "logo.png"
logo = Image.open(logo_file).convert("RGBA") if logo_file.exists() else provisional_logo()


def fit(img: Image.Image, box: int) -> Image.Image:
    img = img.copy()
    img.thumbnail((box, box), Image.LANCZOS)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(img, ((S - img.width) // 2, (S - img.height) // 2), img)
    return canvas


# Ícone: fundo na cor da marca, logo a 70%.
icon = Image.new("RGBA", (S, S), PRIMARY + (255,))
icon.alpha_composite(fit(logo, int(S * 0.70)))
icon.convert("RGB").save(out / "icon.png")

# Android adaptativo: o sistema recorta; o logo fica na área segura (~60%).
fit(logo, int(S * 0.58)).save(out / "adaptive-foreground.png")
mono = fit(logo, int(S * 0.58))
alpha = mono.split()[3]
Image.merge("RGBA", (alpha.point(lambda _: 255),) * 3 + (alpha,)).save(out / "adaptive-monochrome.png")

# Abertura: só o logo (o fundo vem da cor da marca na configuração).
fit(logo, int(S * 0.6)).save(out / "splash.png")
icon.convert("RGB").resize((48, 48), Image.LANCZOS).save(out / "favicon.png")
print(f"marca {brand_id}: imagens em {out.relative_to(ROOT)} ({'logo próprio' if logo_file.exists() else 'logo provisório'})")
