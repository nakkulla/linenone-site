# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Build the site's researchline.html from index.src.html.

Inlines engine.js so the page stays a single self-contained file. The page uses
system fonts only. After editing copy, rebuild:

    uv run site-src/researchline/build.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'researchline.html')


def build():
    src = open(os.path.join(HERE, 'index.src.html'), encoding='utf-8').read()
    engine = open(os.path.join(HERE, 'engine.js'), encoding='utf-8').read()
    html = src.replace('/*ENGINE*/', engine)
    assert '/*ENGINE*/' not in html
    open(OUT, 'w', encoding='utf-8').write(html)
    print(OUT, len(html.encode()), 'bytes')


if __name__ == '__main__':
    build()
