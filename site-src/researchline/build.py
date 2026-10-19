# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools==4.66.1", "brotli==1.2.0"]
# ///
"""Build the site's researchline.html from index.src.html.

Inlines engine.js and glyph-subset woff2 fonts (only the characters the page uses),
so the page stays a single self-contained file. After editing copy, rebuild:

    uv run site-src/researchline/build.py            # write researchline.html
    uv run site-src/researchline/build.py --fetch    # first download the fonts (OFL, google/fonts)

The font files go to site-src/researchline/fonts/ (git-ignored) and are checked by sha256.
"""
import base64, hashlib, io, os, sys, urllib.request
from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FONT_DIR = os.path.join(HERE, 'fonts')
OUT = os.path.join(ROOT, 'researchline.html')
OFL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'

# (family, file, weight, url path under OFL, sha256)
FONTS = [
    ('Plex KR', 'IBMPlexSansKR-Regular.ttf', '400', 'ibmplexsanskr/IBMPlexSansKR-Regular.ttf',
     '53750379270312368cf7641901f43a98dd892e3d9d5798cf25cdc245c85c71c0'),
    ('Plex KR', 'IBMPlexSansKR-Medium.ttf', '500', 'ibmplexsanskr/IBMPlexSansKR-Medium.ttf',
     '4a7130f56ce50bf10f9d383f624e50bad2c80bebc63e51f4269ece2c7d919166'),
    ('Plex KR', 'IBMPlexSansKR-SemiBold.ttf', '600', 'ibmplexsanskr/IBMPlexSansKR-SemiBold.ttf',
     '823c1956adf56c27c06b062725dfce23f266e4fd1366290f2957c8407482a817'),
    ('Plex KR', 'IBMPlexSansKR-Bold.ttf', '700', 'ibmplexsanskr/IBMPlexSansKR-Bold.ttf',
     '9d82a8be5330f6d7b53121262867b402baca672eb69b852928f06d185d357f7d'),
    ('Bricolage', 'BricolageGrotesque[opsz,wdth,wght].ttf', '200 800',
     'bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf',
     '413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682'),
]


def font_path(fname, digest):
    path = os.path.join(FONT_DIR, fname)
    if not os.path.isfile(path):
        sys.exit('missing font %s; run with --fetch first' % fname)
    if hashlib.sha256(open(path, 'rb').read()).hexdigest() != digest:
        sys.exit('sha256 mismatch for %s' % fname)
    return path


def fetch():
    os.makedirs(FONT_DIR, exist_ok=True)
    for _, fname, _, url, digest in FONTS:
        data = urllib.request.urlopen(OFL + url).read()
        if hashlib.sha256(data).hexdigest() != digest:
            sys.exit('sha256 mismatch for downloaded %s' % fname)
        open(os.path.join(FONT_DIR, fname), 'wb').write(data)


def subset_font(path, text):
    # Keep head.modified from the source font so rebuilds are byte-identical.
    font = TTFont(path, recalcTimestamp=False)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    s = subset.Subsetter(opts)
    s.populate(text=text)
    s.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue()


def build():
    src = open(os.path.join(HERE, 'index.src.html'), encoding='utf-8').read()
    engine = open(os.path.join(HERE, 'engine.js'), encoding='utf-8').read()
    html = src.replace('/*ENGINE*/', engine)
    text = ''.join(sorted(set(html))) + ''.join(chr(c) for c in range(0x20, 0x7f))
    faces = []
    for fam, fname, weight, _, digest in FONTS:
        data = subset_font(font_path(fname, digest), text)
        faces.append("@font-face{font-family:'%s';src:url(data:font/woff2;base64,%s) format('woff2');font-weight:%s;font-style:normal;font-display:swap}"
                     % (fam, base64.b64encode(data).decode(), weight))
    html = html.replace('/*FONTS*/', '\n'.join(faces))
    assert '/*FONTS*/' not in html and '/*ENGINE*/' not in html
    open(OUT, 'w', encoding='utf-8').write(html)
    print(OUT, len(html.encode()), 'bytes')


if __name__ == '__main__':
    if '--fetch' in sys.argv[1:]:
        fetch()
    build()
