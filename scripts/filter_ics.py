#!/usr/bin/env python3
"""Filter een (persoonlijke) Sportlink-iCal tot alleen de wedstrijden van één team.

Gebruik: filter_ics.py IN.ics OUT.ics [TEAM_REGEX]
- Houdt de kalenderkop en VTIMEZONE-blokken.
- Houdt alleen VEVENTs waarvan de SUMMARY het team noemt (standaard O10-3 / JO10-3).
- Haalt persoonsgebonden regels weg (ATTENDEE, ORGANIZER, CONTACT, URL met token).
Zo komt er niets persoonlijks in de openbare repository.
"""
import re
import sys

DROP = re.compile(r'^(ATTENDEE|ORGANIZER|CONTACT|X-[A-Z-]*EMAIL|URL)[;:]', re.I)


def unfold(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    return re.sub(r'\n[ \t]', '', text).split('\n')


def main():
    src, dst = sys.argv[1], sys.argv[2]
    team = re.compile(sys.argv[3] if len(sys.argv) > 3 else r'\bJ?O10-3\b', re.I)
    lines = unfold(open(src, encoding='utf-8', errors='replace').read())
    out, block, kept, total = [], None, 0, 0
    for line in lines:
        if not line.strip():
            continue
        if line.upper() == 'BEGIN:VEVENT':
            block = [line]
            continue
        if block is not None:
            if not DROP.match(line):
                block.append(line)
            if line.upper() == 'END:VEVENT':
                total += 1
                summary = next((l.split(':', 1)[1] for l in block if l.upper().startswith('SUMMARY')), '')
                if team.search(summary):
                    out.extend(block)
                    kept += 1
                block = None
            continue
        if line.upper().startswith(('X-WR-CALNAME', 'X-WR-CALDESC')):
            continue  # kalendernaam bevat vaak de naam van de persoon
        out.append(line)
    if not any(l.upper() == 'END:VCALENDAR' for l in out):
        out.append('END:VCALENDAR')
    with open(dst, 'w', encoding='utf-8', newline='') as f:
        f.write('\r\n'.join(out) + '\r\n')
    print(f'{kept} van {total} items bewaard')


if __name__ == '__main__':
    main()
