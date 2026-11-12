import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
output = root / 'dist' / f'selected-text-translator-{manifest["version"]}.zip'
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ['manifest.json', 'README.md', 'LICENSE']]
files.extend(sorted(path for directory in ['src', 'assets'] for path in (root / directory).rglob('*') if path.is_file()))
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(root))
with ZipFile(output) as archive:
    assert archive.testzip() is None
    entries = set(archive.namelist())
    required = [manifest['background']['service_worker'], manifest['action']['default_popup']]
    required.extend(file for script in manifest['content_scripts'] for file in script['js'])
    assert all(path in entries for path in required)
print(f'{output} ({len(files)} files, {output.stat().st_size:,} bytes)')
