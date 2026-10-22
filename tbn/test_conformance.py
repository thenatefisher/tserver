#!/usr/bin/env python3
"""Static standalone-HTML packaging checks; never launches Node or a local server.

Browser execution and authoritative server/schema validation remain separate checks.
"""
import argparse
import base64
import json
import re
import struct
from html.parser import HTMLParser
from pathlib import Path


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.actor_chunks = []
        self.actor_scripts = 0
        self.in_actor = False
        self.references = []
        self.scripts = []
        self.in_script = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            self.in_actor = attrs.get('id') == 'tbn-actor'
            self.in_script = attrs.get('type', '').lower() != 'application/json'
            if self.in_actor:
                self.actor_scripts += 1
            if self.in_script:
                self.scripts.append('')
        for key in ('src', 'poster', 'srcset'):
            if key in attrs:
                self.references.append(attrs[key])
        if tag == 'link' and 'href' in attrs:
            self.references.append(attrs['href'])

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_actor = self.in_script = False

    def handle_data(self, data):
        if self.in_actor:
            self.actor_chunks.append(data)
        if self.in_script:
            self.scripts[-1] += data


def check(root):
    errors = []
    for filename in ('index.html', 'actor.glb', 'actor.json'):
        if not (root / filename).is_file():
            errors.append(f'Missing root {filename}')
    for filename in ('client.js', 'app.js', 'server.js'):
        if (root / filename).exists():
            errors.append(f'{filename} is not a standalone browser entry point; embed game code in index.html')
    if not (root / 'index.html').is_file():
        return errors
    html = (root / 'index.html').read_text(encoding='utf-8')
    page = Page()
    page.feed(html)
    hosted_scripts = {'https://open.thisagentmd.com/tbn.js', 'https://open.thisagentmd.com/socket.io/socket.io.js'}
    for ref in page.references:
        if not ref.startswith('data:') and ref not in hosted_scripts:
            errors.append(f'External/sibling dependency must be embedded: {ref}')
    for ref in re.findall(r'url\(\s*[\'"]?([^\s)\'"]+)', html, re.I):
        if not ref.startswith(('data:', '#')):
            errors.append(f'CSS dependency must be embedded: {ref}')
    scripts = '\n'.join(page.scripts)
    if 'https://open.thisagentmd.com' not in scripts and not any(ref in hosted_scripts for ref in page.references):
        errors.append('Load the hosted TBN client or specify https://open.thisagentmd.com')
    if re.search(r'\brequire\s*\(|\bimport\s*(?:\(|[\'"{*])', scripts):
        errors.append('Bundle runtime imports/require into inline browser JavaScript')
    if re.search(r'\bfetch\s*\(\s*[\'"](?:\.?\.?/|actor\.(?:json|glb))', scripts):
        errors.append('Do not fetch sibling files from file://; use embedded assets')
    if page.actor_scripts != 1:
        errors.append('Exactly one JSON script with id=tbn-actor is required')
    else:
        try:
            actor = json.loads(''.join(page.actor_chunks))
            if (root / 'actor.json').is_file():
                if actor != json.loads((root / 'actor.json').read_text()):
                    errors.append('Embedded actor package differs from actor.json')
            binary = base64.b64decode(actor['mesh']['glb'], validate=True)
            if (root / 'actor.glb').is_file() and binary != (root / 'actor.glb').read_bytes():
                errors.append('Embedded GLB differs from actor.glb')
            if len(binary) < 12:
                errors.append('GLB header is missing')
            else:
                magic, version, length = struct.unpack('<4sII', binary[:12])
                if magic != b'glTF' or version != 2 or length != len(binary):
                    errors.append('GLB must have a valid version-2 header and matching length')
            if len(binary) > 16 * 1024 * 1024:
                errors.append('GLB exceeds 16 MiB')
        except (ValueError, KeyError, TypeError) as error:
            errors.append(f'Invalid embedded actor package: {error}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    errors = check(args.root)
    report = {'passed': not errors, 'violation_count': len(errors), 'violations': errors,
              'scope': 'Static packaging only; browser runtime, full JSON Schema and geometry checks remain required.'}
    print(json.dumps(report, indent=2) if args.json else '\n'.join(errors) if errors else '0 violations (static packaging checks). Browser/server checks still required.')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
