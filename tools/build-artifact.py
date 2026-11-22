#!/usr/bin/env python3
"""Bundle index.html + styles.css + app.js into one self-contained page for hosting
as a private Claude artifact (dist/pocketwise.html). The artifact host wraps the page
in its own <html>/<head>, so this emits only the title, styles, body markup and script."""
import base64, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text()
css = (root / 'styles.css').read_text()
js = (root / 'app.js').read_text()
icon = 'data:image/svg+xml;base64,' + base64.b64encode((root / 'icon.svg').read_bytes()).decode()

body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
body = re.sub(r'\s*<script src="app.js"></script>', '', body)
body = body.replace('src="icon.svg"', f'src="{icon}"')

out = f'''<title>Pocketwise Budget</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
{css}
</style>
{body.strip()}
<script>
{js}
</script>
'''
dist = root / 'dist'
dist.mkdir(exist_ok=True)
(dist / 'pocketwise.html').write_text(out)
print('wrote', dist / 'pocketwise.html', len(out), 'bytes')
