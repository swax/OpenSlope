"""Session and persistent music reuse across every supported family, using authored fixtures."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
from import_test import big, iso
from audio_import_test import archive, disc, fixture as tricky
from ssx_import_test import members as ssx
from ssx3_import_test import members as ssx3
from ontour_import_test import members as tour
from avalanche_import_test import course_packages, gcm, rvz
from avalanche_music_test import music_files
from madtrix_import_test import members as madtrix, package, iso as mad_iso, music_bank


def fixtures():
    return [
        ('tricky', disc(tricky()), 1),
        ('ssx', iso(big(ssx())), 0),
        ('ssx3', disc({'DATA/WORLDS/BAM.BIG': archive(ssx3())}), 0),
        ('ontour', disc({'DATA/WORLDS/BAM.BIG': archive(tour())}), 0),
        ('avalanche', rvz(gcm(course_packages() | music_files()), packing=True), 2),
        ('madtrix', mad_iso(package(madtrix()), music=music_bank()), 2),
    ]


def main():
    binary=Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-sessions-') as temporary:
        root=Path(temporary)
        for game,data,count in fixtures():
            source=root/(game+('.rvz' if game=='avalanche' else '.iso')); source.write_bytes(data)
            result=subprocess.run([str(binary),str(source),str(root/game),str(count)],capture_output=True,text=True,timeout=120)
            assert result.returncode==0,game+': '+result.stdout+result.stderr
            print(game+': '+result.stdout.strip())
    print('PASS: six game families reuse scans and reads; all supported music survives session restarts')


if __name__=='__main__':
    main()
