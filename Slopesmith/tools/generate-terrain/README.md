# OpenSlope-Generate — ski-mountain height-map builder

Generic pipeline that turns a small JSON config into a high-res, georeferenced
height map of a ski mountain, positioned to contain the **most skiable terrain**.

Built for feeding real mountains into the OpenSlope terrain workflow. One mountain
config ships ready to run: **Mammoth** (3 km × 3 km, true 1 m lidar) —
`python Slopesmith/tools/generate-terrain/openslopegen.py mammoth` builds it into the
git-ignored `temp/GenerateTerrain/Mammoth/` directory.

## How it works
`openslopegen.py` runs four steps, all from `mountains/<name>.json`:

1. **Analyze** — pulls OSM downhill pistes for the search bbox and grid-searches the
   `box_m` square that captures the most piste length → the box center.
2. **Coverage** — queries the USGS 3DEP 1-meter DEM index to confirm true 1 m lidar.
3. **Fetch** — downloads the DEM from the USGS 3DEP seamless ImageServer as a grid of
   tiles (a single full-size request times out), mosaics them, and reprojects to the
   **local UTM zone (auto-detected from the center longitude — works anywhere)**.
4. **Export** — writes the outputs into `./<Name>/`.

## Usage
```bash
python -m pip install -r Slopesmith/tools/generate-terrain/requirements.txt
python Slopesmith/tools/generate-terrain/openslopegen.py mammoth                 # full build  -> temp/GenerateTerrain/Mammoth/
python Slopesmith/tools/generate-terrain/openslopegen.py mammoth --analyze-only  # just find the box (no DEM download)
python Slopesmith/tools/generate-terrain/openslopegen.py --config Slopesmith/tools/generate-terrain/mountains/mammoth.json
```

Requires: `numpy pillow pyproj tifffile imagecodecs` (listed in `requirements.txt`).

## Add another mountain
Drop a JSON in `mountains/`, e.g. `mountains/whistler.json`:
```json
{
  "name": "Whistler",
  "search_bbox": [-123.00, 50.05, -122.85, 50.15],
  "box_m": 3000,
  "npix": 3000,
  "center_lonlat": null
}
```
- `search_bbox` = `W,S,E,N` lon/lat envelope to gather pistes from.
- `center_lonlat: null` → auto-pick the best window; or pin `[lon, lat]` yourself.
- `box_m` / `npix` → window size and pixels (`npix == box_m` gives 1 m/px).

Then `python Slopesmith/tools/generate-terrain/openslopegen.py whistler`.

## Outputs (per mountain, in `temp/GenerateTerrain/<Name>/`)
| File | What |
|------|------|
| `<name>_dem_1m_utm<zone>.tif` | authoritative float32 GeoTIFF, metres, georeferenced |
| `height16.png` | 16-bit grayscale height map (0–65535) |
| `height16_<npix>x<npix>_16bit_LE.raw` | 16-bit LE raw for Unity / mesh builders |
| `hillshade.png` | preview for visual QA |
| `manifest.json` | georef + elevation + decode metadata |
| `osm_pistes.json`, `piste_analysis.json`, `idx_1m.json` | provenance |

Decode 16-bit height back to metres with the formula in that mountain's `manifest.json`
(`height16_decode`).

## Source & limits
DEM source is **USGS 3DEP — United States only**. UTM-zone auto-detection already works
globally; to support non-US mountains, swap `fetch_dem()` for a global provider
(e.g. OpenTopography global DEMs / a national service). The 1 m coverage check is
non-fatal, so it degrades gracefully where 3DEP has only coarser data.

## Data sources & attribution

Two public sources, queried at run time and neither one redistributed here:

- **Elevation — [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) lidar.** A United States
  Government work, in the public domain. Every height map this tool writes is 3DEP data.
- **Ski pistes — © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors**, licensed
  **ODbL 1.0**. Used only in step 1, to decide *which* square of terrain to fetch. The height maps
  are not a derivative database and carry no ODbL obligation; the `osm_pistes.json` written beside
  them **is** OSM data and stays under ODbL. Attribute it if you publish anything drawn from it.

Piste queries go through the volunteer-run [Overpass API](https://overpass-api.de/), whose published
usage expectations apply. This tool issues one bbox query per analyze run, which is well within
them; a loop over many mountains is not — run your own instance for that.
