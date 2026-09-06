"""OpenSlope-Generate — build a high-res ski-mountain height map from a small config.

Pipeline (all driven by a per-mountain JSON config in ./mountains/<name>.json):
  1. ANALYZE  pull OSM downhill pistes for the search bbox, grid-search the
              box_m x box_m window that captures the most piste length.
  2. COVERAGE query the USGS 3DEP 1-meter DEM index to confirm true 1 m lidar
              (US only; non-fatal elsewhere).
  3. FETCH    download the DEM from the USGS 3DEP seamless ImageServer as a grid
              of tiles (a single big request 504s), mosaic, reproject to the
              local UTM zone (auto-detected from the center longitude).
  4. EXPORT   temp/GenerateTerrain/<name>/<name>_dem_1m_utm<zone><hemi>.tif
              (float metres, georeferenced)
              + height16.png + 16-bit LE .raw + hillshade.png + manifest.json

Usage:
  python Slopesmith/tools/generate-terrain/openslopegen.py mammoth                 # full build -> temp/GenerateTerrain/Mammoth/
  python Slopesmith/tools/generate-terrain/openslopegen.py mammoth --analyze-only  # just find the box (no DEM download)
  python Slopesmith/tools/generate-terrain/openslopegen.py --config path/to.json   # explicit config path

Add a mountain: drop a JSON in ./mountains/ (see mountains/mammoth.json). The DEM
source is USGS 3DEP (United States only); swap fetch_dem() for a global source
(e.g. OpenTopography) to support mountains outside the US.
"""
import argparse, io, json, math, os, sys, time, urllib.parse, urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
EXPORT = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
INDEX1M = "https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/18/query"
UA = {"User-Agent": "Mozilla/5.0 (OpenSlope-Generate height-map builder)"}
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUTPUT_ROOT = os.path.join(REPO_ROOT, "temp", "GenerateTerrain")


# ---------------------------------------------------------------- config -----
def load_config(name=None, path=None):
    if path is None:
        path = os.path.join(HERE, "mountains", f"{name.lower()}.json")
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("name", name or os.path.splitext(os.path.basename(path))[0].title())
    cfg.setdefault("box_m", 3000)
    cfg.setdefault("npix", cfg["box_m"])           # default 1 m / px
    cfg.setdefault("center_lonlat", None)          # null => derive from pistes
    cfg.setdefault("out_dir", os.path.join(OUTPUT_ROOT, cfg["name"]))
    return cfg


def utm_epsg(lon, lat):
    zone = int((lon + 180) // 6) + 1
    north = lat >= 0
    return (32600 if north else 32700) + zone, zone, ("n" if north else "s")


# --------------------------------------------------------------- analyze -----
def fetch_pistes(bbox_wsen, out_dir):
    """bbox_wsen = (W, S, E, N) lon/lat. Returns OSM elements, saves osm_pistes.json."""
    w, s, e, n = bbox_wsen
    q = (f"[out:json][timeout:90];("
         f'way["piste:type"="downhill"]({s},{w},{n},{e});'
         f'way["aerialway"]({s},{w},{n},{e}););out geom;')
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    with open(os.path.join(out_dir, "osm_pistes.json"), "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data["elements"]


def best_window(elements, box_m, out_dir):
    """Grid-search the box_m square that maximises downhill-piste length."""
    pistes, lifts = [], []
    for el in elements:
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        pts = [(g["lon"], g["lat"]) for g in el["geometry"]]
        if el.get("tags", {}).get("piste:type") == "downhill":
            pistes.append(pts)
        elif "aerialway" in el.get("tags", {}):
            lifts.append(pts)
    allp = [p for w in pistes for p in w]
    if not allp:
        raise SystemExit("No downhill pistes found in search bbox.")
    lons = [p[0] for p in allp]; lats = [p[1] for p in allp]
    lon0 = (min(lons) + max(lons)) / 2; lat0 = (min(lats) + max(lats)) / 2
    MX = math.cos(math.radians(lat0)) * 111320.0; MY = 110540.0
    to_m = lambda lo, la: ((lo - lon0) * MX, (la - lat0) * MY)

    segs = []
    for w in pistes:
        for a, b in zip(w, w[1:]):
            ax, ay = to_m(*a); bx, by = to_m(*b)
            L = math.hypot(bx - ax, by - ay)
            if L > 0:
                segs.append(((ax + bx) / 2, (ay + by) / 2, L))
    total = sum(s[2] for s in segs)
    xs = [to_m(*p)[0] for p in allp]; ys = [to_m(*p)[1] for p in allp]

    half = box_m / 2; step = 25.0
    best = (-1.0, 0.0, 0.0)
    cx = min(xs) - half
    while cx <= max(xs) + half:
        cy = min(ys) - half
        while cy <= max(ys) + half:
            cap = sum(L for mx, my, L in segs
                      if cx - half <= mx <= cx + half and cy - half <= my <= cy + half)
            if cap > best[0]:
                best = (cap, cx, cy)
            cy += step
        cx += step
    cap, cx, cy = best
    clon = lon0 + cx / MX; clat = lat0 + cy / MY
    res = {
        "box_m": box_m, "center_lonlat": [clon, clat],
        "captured_km": cap / 1000, "total_km": total / 1000,
        "captured_pct": 100 * cap / total,
        "skiable_extent_m": [max(xs) - min(xs), max(ys) - min(ys)],
        "piste_bbox_lonlat": [min(lons), min(lats), max(lons), max(lats)],
        "n_pistes": len(pistes), "n_lifts": len(lifts),
    }
    with open(os.path.join(out_dir, "piste_analysis.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
    print(f"  pistes: {len(pistes)} ways / {total/1000:.1f} km; "
          f"extent {res['skiable_extent_m'][0]:.0f}x{res['skiable_extent_m'][1]:.0f} m")
    print(f"  best {box_m} m window: center {clon:.6f},{clat:.6f} "
          f"captures {res['captured_pct']:.1f}% of piste length")
    return res


# -------------------------------------------------------------- coverage -----
def check_1m_coverage(bbox_wsen, out_dir):
    w, s, e, n = bbox_wsen
    try:
        url = INDEX1M + "?" + urllib.parse.urlencode({
            "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "outFields": "project,project_id", "returnGeometry": "false", "f": "json"})
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
            d = json.loads(r.read())
        feats = d.get("features", [])
        projs = sorted({f["attributes"].get("project") for f in feats})
        with open(os.path.join(out_dir, "idx_1m.json"), "w", encoding="utf-8") as f:
            json.dump(d, f)
        if projs:
            print(f"  1 m lidar coverage CONFIRMED: {', '.join(p for p in projs if p)}")
            return projs
        print("  WARNING: no 1 m DEM index coverage (resampled coarser source or non-US).")
    except Exception as ex:
        print(f"  coverage check skipped ({ex}).")
    return []


# ----------------------------------------------------------------- fetch -----
def _tile(bx0, by0, bx1, by1, px, epsg):
    import tifffile
    params = {"bbox": f"{bx0},{by0},{bx1},{by1}", "bboxSR": epsg, "imageSR": epsg,
              "size": f"{px},{px}", "format": "tiff", "pixelType": "F32",
              "interpolation": "RSP_BilinearInterpolation",
              "noData": "", "adjustAspectRatio": "false", "f": "image"}
    url = EXPORT + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                buf = r.read()
            if buf[:1] == b"{":
                raise RuntimeError("server JSON: " + buf[:200].decode("utf-8", "replace"))
            t = tifffile.imread(io.BytesIO(buf)).astype(np.float32)
            return t[..., 0] if t.ndim == 3 else t
        except Exception as ex:
            last = ex; print(f"    retry {attempt+1}/4: {ex}")
            time.sleep(3 * (attempt + 1))
    raise last


def fetch_dem(center, box_m, npix, epsg, zone, hemi, out_dir, name):
    import tifffile
    from pyproj import Transformer
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    to_geo = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    cx, cy = (round(v) for v in to_utm.transform(*center))
    half = box_m // 2
    xmin, ymin, xmax, ymax = cx - half, cy - half, cx + half, cy + half
    print(f"  UTM{zone}{hemi.upper()} bbox {xmin},{ymin},{xmax},{ymax} ({box_m}x{box_m} m)")

    tile = 1000 if npix % 1000 == 0 else npix
    grid = npix // tile
    arr = np.full((npix, npix), np.nan, dtype=np.float32)
    print(f"  downloading {grid}x{grid} tiles of {tile}px ...")
    for i in range(grid):
        for j in range(grid):
            tx0 = xmin + j * tile; ty1 = ymax - i * tile
            t = _tile(tx0, ty1 - tile, tx0 + tile, ty1, tile, epsg)
            arr[i*tile:(i+1)*tile, j*tile:(j+1)*tile] = t
    print(f"    tiles done; raw z[{np.nanmin(arr):.0f},{np.nanmax(arr):.0f}]")

    nod = (arr < -1e30) | (arr > 1e30) | np.isnan(arr)
    valid = arr[~nod]; zmin, zmax = float(valid.min()), float(valid.max())
    filled = arr.copy(); filled[nod] = zmin
    print(f"  elevation {zmin:.1f}..{zmax:.1f} m (relief {zmax-zmin:.1f} m), "
          f"nodata {int(nod.sum())} px")

    tif = f"{name.lower()}_dem_1m_utm{zone}{hemi}.tif"
    px_scale = box_m / npix
    geotags = [(33550, 'd', 3, (px_scale, px_scale, 0.0)),
               (33922, 'd', 6, (0.0, 0.0, 0.0, float(xmin), float(ymax), 0.0)),
               (34735, 'H', 16, (1,1,0,3, 1024,0,1,1, 1025,0,1,1, 3072,0,1,epsg))]
    tifffile.imwrite(os.path.join(out_dir, tif), arr, dtype=np.float32,
                     photometric='minisblack', compression='deflate', extratags=geotags)

    from PIL import Image
    u16 = np.clip(np.rint((filled - zmin) / (zmax - zmin) * 65535.0), 0, 65535).astype(np.uint16)
    Image.fromarray(u16).save(os.path.join(out_dir, "height16.png"))
    u16.astype("<u2").tofile(os.path.join(out_dir, f"height16_{npix}x{npix}_16bit_LE.raw"))

    def hillshade(z, az=315.0, alt=45.0, cell=1.0):
        gy, gx = np.gradient(z.astype(np.float64), cell, cell)
        slope = np.pi/2 - np.arctan(np.hypot(gx, gy)); aspect = np.arctan2(-gx, gy)
        azr = math.radians(360 - az + 90); alr = math.radians(alt)
        return np.clip(np.sin(alr)*np.sin(slope) +
                       np.cos(alr)*np.cos(slope)*np.cos(azr - aspect), 0, 1)
    Image.fromarray((hillshade(filled)*255).astype(np.uint8), mode="L").save(
        os.path.join(out_dir, "hillshade.png"))

    cw, cn = to_geo.transform(xmin, ymax); ce, cs = to_geo.transform(xmax, ymin)
    return {
        "crs": f"EPSG:{epsg} (WGS84 / UTM zone {zone}{hemi.upper()})",
        "utm_bbox_xmin_ymin_xmax_ymax": [xmin, ymin, xmax, ymax],
        "corners_lonlat": {"NW": [cw, cn], "SE": [ce, cs]},
        "size_px": [npix, npix], "ground_sample_distance_m": px_scale,
        "elevation_min_m": zmin, "elevation_max_m": zmax, "relief_m": zmax - zmin,
        "nodata_pixels": int(nod.sum()),
        "height16_decode": f"elev_m = {zmin:.2f} + (pixel/65535)*{zmax-zmin:.2f}",
        "files": {"geotiff_float_m": tif, "height16_png": "height16.png",
                  "height16_raw": f"height16_{npix}x{npix}_16bit_LE.raw",
                  "hillshade_png": "hillshade.png"},
    }


# ------------------------------------------------------------------ main -----
def build(cfg, analyze_only=False):
    global np
    try:
        import numpy as np
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing terrain-generator dependencies. Run: "
            "python -m pip install -r Slopesmith/tools/generate-terrain/requirements.txt"
        ) from exc

    os.makedirs(cfg["out_dir"], exist_ok=True)
    print(f"== {cfg['name']} ==  out: {cfg['out_dir']}")

    print("[1] analyze pistes")
    elements = fetch_pistes(cfg["search_bbox"], cfg["out_dir"])
    analysis = best_window(elements, cfg["box_m"], cfg["out_dir"])
    center = cfg["center_lonlat"] or analysis["center_lonlat"]
    print(f"  using center {center[0]:.6f},{center[1]:.6f}"
          f"{' (pinned by config)' if cfg['center_lonlat'] else ' (auto)'}")

    if analyze_only:
        print("analyze-only: stopping before DEM download."); return

    epsg, zone, hemi = utm_epsg(*center)
    print("[2] coverage"); projs = check_1m_coverage(cfg["search_bbox"], cfg["out_dir"])
    print("[3] fetch + export DEM")
    geo = fetch_dem(center, cfg["box_m"], cfg["npix"], epsg, zone, hemi,
                    cfg["out_dir"], cfg["name"])

    manifest = {"name": f"{cfg['name']} {cfg['box_m']//1000}km {geo['ground_sample_distance_m']:g}m DEM",
                "source": "USGS 3DEP seamless ImageServer",
                "lidar_projects": projs, "center_lonlat": center,
                "skiable_capture": f"{analysis['captured_pct']:.1f}% of OSM downhill-piste length",
                **geo}
    with open(os.path.join(cfg["out_dir"], "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"  wrote manifest.json -> done. {geo['height16_decode']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build a ski-mountain height map.")
    ap.add_argument("name", nargs="?", help="mountain config name (mountains/<name>.json)")
    ap.add_argument("--config", help="explicit path to a config JSON")
    ap.add_argument("--analyze-only", action="store_true", help="find the box, skip DEM download")
    a = ap.parse_args()
    if not a.name and not a.config:
        ap.error("give a mountain name or --config")
    build(load_config(a.name, a.config), analyze_only=a.analyze_only)
