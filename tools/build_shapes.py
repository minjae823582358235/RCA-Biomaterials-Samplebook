"""Turn the rough Inkscape trace paths into smooth interaction outlines + specimen cutouts.

Run:   python tools/build_shapes.py [--debug]
Needs: numpy, pillow, scipy, scikit-image

Outputs (into the project folder):
  assets/plate.jpg                 web-sized background photo
  assets/specimens/<id>.webp       per-sample cutout (alpha) at full photo resolution
  js/shapes.js                     generated geometry (outline path, bbox, cutout placement)
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi
from skimage import color, filters, measure, morphology

sys.path.insert(0, os.path.dirname(__file__))
from svgpaths import flatten, load_paths  # noqa: E402

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTO = os.path.join(PROJ, "Bioimmersion Background Photo.jpg")
W, H = 5043, 3463
S = 0.5  # working scale for mask processing
w, h = int(W * S), int(H * S)

# Traces that only cover part of their sample: grow them from the photo itself.
# value = (window margin in full-res px, mode)
REFINE = {
    "path55": (180, "free"),
    "path45": ((900, 800, 1650, 2150), "free"),
    "path38": (160, "free"),
    "path24": (160, "free"),
    "path10": (120, "free"),
    "path2": (160, "free"),
    "path1": (160, "free"),
    "path14": (0, "tray"),
    "path33": (12.5, "traybox"),
    "path34": (12.5, "traybox"),
}
# Flat sheets whose segmentation leaves bites out of the edge.
HULL = {"path38", "path45"}
# Samples sitting in white trays: strip the tray-edge slivers the trace picked up.
TRAY = {"path51", "path41", "path33", "path34", "path25", "path21", "path20",
        "path19", "path16", "path12", "path11", "path3"}
# Fragmented samples that should read as one blob.
BLOBBY = {"path2": 22, "path41": 14, "path14": 22, "path51": 6}

photo = Image.open(PHOTO).convert("RGB")
small = np.asarray(photo.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0
lab = color.rgb2lab(small)


def raster(subs):
    im = Image.new("L", (w, h), 0)
    dr = ImageDraw.Draw(im)
    for s in subs:
        pts = [(x * S, y * S) for x, y in s]
        if len(pts) > 2:
            dr.polygon(pts, fill=255)
    return np.asarray(im) > 0


def largest(mask, keep_ratio=0.12):
    lbl, n = ndi.label(mask)
    if n == 0:
        return mask
    sizes = ndi.sum(mask, lbl, range(1, n + 1))
    big = sizes.max()
    keep = [i + 1 for i, s in enumerate(sizes) if s >= big * keep_ratio]
    return np.isin(lbl, keep)


def refine_free(seed, margin):
    ys, xs = np.nonzero(seed)
    if isinstance(margin, tuple):
        x0, y0, x1, y1 = (int(v * S) for v in margin)
    else:
        m = int(margin * S)
        x0, x1 = max(xs.min() - m, 0), min(xs.max() + m, w - 1)
        y0, y1 = max(ys.min() - m, 0), min(ys.max() + m, h - 1)
    win = lab[y0:y1, x0:x1]
    # background = median of the window border ring
    ring = np.concatenate([win[:6].reshape(-1, 3), win[-6:].reshape(-1, 3),
                           win[:, :6].reshape(-1, 3), win[:, -6:].reshape(-1, 3)])
    bg = np.median(ring, axis=0)
    # allow for the vignette: fit a plane to the ring luminance
    yy, xx = np.mgrid[0:win.shape[0], 0:win.shape[1]]
    ring_mask = np.zeros(win.shape[:2], bool)
    ring_mask[:6] = ring_mask[-6:] = True
    ring_mask[:, :6] = ring_mask[:, -6:] = True
    A = np.c_[xx[ring_mask], yy[ring_mask], np.ones(ring_mask.sum())]
    bgL = np.linalg.lstsq(A, win[..., 0][ring_mask], rcond=None)[0]
    Lplane = bgL[0] * xx + bgL[1] * yy + bgL[2]
    dL = win[..., 0] - Lplane
    dab = np.hypot(win[..., 1] - bg[1], win[..., 2] - bg[2])
    # brighter or more chromatic than the paper; ignore soft (darker, neutral) shadows
    score = np.maximum(dL, 0) * 0.9 + dab * 1.6 + np.maximum(-dL - 14, 0) * 0.8
    score = filters.gaussian(score, 1.2)
    t = filters.threshold_otsu(score)
    fg = score > max(t, 4.5)
    fg = morphology.binary_opening(fg, morphology.disk(2))
    fg = morphology.binary_closing(fg, morphology.disk(4))
    lbl = measure.label(fg)
    seed_win = seed[y0:y1, x0:x1]
    touching = np.unique(lbl[morphology.binary_dilation(seed_win, morphology.disk(3)) & (lbl > 0)])
    out = np.zeros_like(seed)
    region = np.isin(lbl, touching[touching > 0]) | seed_win
    out[y0:y1, x0:x1] = region
    return out


def refine_tray(seed):
    """Sample lying in a white tray: yellow/brown fragments vs neutral white plastic."""
    ys, xs = np.nonzero(seed)
    # the tray is roughly 130px (full res ~260) around the seed: search the tray interior
    cy, cx = int(ys.mean()), int(xs.mean())
    r = int(260 * S)
    y0, y1, x0, x1 = max(cy - r, 0), min(cy + r, h), max(cx - r, 0), min(cx + r, w)
    win = lab[y0:y1, x0:x1]
    chroma = win[..., 2]  # b* (yellow)
    fg = (chroma > 14) & (win[..., 0] > 35)
    fg = morphology.binary_opening(fg, morphology.disk(1))
    out = np.zeros_like(seed)
    out[y0:y1, x0:x1] = fg
    # keep blobs near the seed only
    near = morphology.binary_dilation(seed, morphology.disk(int(200 * S)))
    return (out & near) | seed


def refine_traybox(seed, thresh):
    """The trace only caught the tray rim: segment the sample inside the rim by yellowness."""
    ys, xs = np.nonzero(seed)
    inset = int(45 * S)
    y0, y1, x0, x1 = ys.min() + inset, ys.max() - inset, xs.min() + inset, xs.max() - inset
    win = lab[y0:y1, x0:x1]
    fg = filters.gaussian(win[..., 2], 2.0) > thresh
    fg = morphology.binary_opening(fg, morphology.disk(4))
    fg = largest(fg, 0.5)
    out = np.zeros_like(seed)
    out[y0:y1, x0:x1] = fg
    return out


def smooth_contour(mask, sigma):
    f = filters.gaussian(mask.astype(float), sigma)
    cs = measure.find_contours(f, 0.5)
    c = max(cs, key=len)
    c = measure.approximate_polygon(c, tolerance=0.9)
    return c  # (row, col) in working scale


def catmull_rom(pts, scale):
    """Closed Catmull-Rom spline through pts (x, y) -> SVG cubic path in full-res units."""
    p = [(x / scale, y / scale) for x, y in pts]
    if p[0] == p[-1]:
        p = p[:-1]
    n = len(p)
    d = [f"M{p[0][0]:.1f},{p[0][1]:.1f}"]
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    return "".join(d) + "Z"


def main():
    os.makedirs(os.path.join(PROJ, "assets", "specimens"), exist_ok=True)
    os.makedirs(os.path.join(PROJ, "js"), exist_ok=True)
    shapes = {}
    debug = photo.resize((w, h)).convert("RGBA")
    dbg = ImageDraw.Draw(debug)
    for pid, d in load_paths():
        seed = raster(flatten(d))
        if pid in REFINE:
            margin, mode = REFINE[pid]
            if mode == "free":
                m = refine_free(seed, margin)
            elif mode == "traybox":
                m = refine_traybox(seed, margin)
            else:
                m = refine_tray(seed)
        else:
            m = seed.copy()
        if pid in TRAY:
            m = morphology.binary_opening(m, morphology.disk(9))
            m = largest(m, 0.25)
        m = morphology.binary_closing(m, morphology.disk(BLOBBY.get(pid, 5)))
        m = ndi.binary_fill_holes(m)
        m = largest(m, 0.05)
        m = ndi.binary_fill_holes(morphology.binary_closing(m, morphology.disk(BLOBBY.get(pid, 5))))
        if pid in HULL:
            m = morphology.convex_hull_image(m)

        # tight specimen shape (for the cutout) and a relaxed, offset outline (for interaction)
        # pull the cut-out edge in a touch so no background paper rims the specimen
        tight = morphology.binary_erosion(m, morphology.disk(1))
        outline_mask = morphology.binary_dilation(m, morphology.disk(9))
        contour = smooth_contour(outline_mask, sigma=5.0)
        xy = [(c[1], c[0]) for c in contour]
        path_d = catmull_rom(xy, S)

        xs = [x / S for x, _ in xy]
        ys = [y / S for _, y in xy]
        bbox = [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
        cy, cx = ndi.center_of_mass(m)

        # full-res cutout with a feathered alpha
        ty, tx = np.nonzero(tight)
        pad = 12
        X0, Y0 = max(int(tx.min() / S) - pad, 0), max(int(ty.min() / S) - pad, 0)
        X1, Y1 = min(int(tx.max() / S) + pad, W), min(int(ty.max() / S) + pad, H)
        alpha = Image.fromarray((tight * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)
        alpha = alpha.crop((X0, Y0, X1, Y1)).filter(ImageFilter.GaussianBlur(2.0))
        cut = photo.crop((X0, Y0, X1, Y1)).convert("RGBA")
        cut.putalpha(alpha)
        cut.save(os.path.join(PROJ, "assets", "specimens", f"{pid}.webp"), quality=86, method=6)

        shapes[pid] = {
            "d": path_d,
            "bbox": [round(v, 1) for v in bbox],
            "center": [round(cx / S, 1), round(cy / S, 1)],
            "cut": {"src": f"assets/specimens/{pid}.webp", "x": X0, "y": Y0, "w": X1 - X0, "h": Y1 - Y0},
        }
        dbg.line(xy + [xy[0]], fill=(255, 0, 90, 255), width=3)
        dbg.text((cx - 10, cy - 6), pid[4:], fill=(0, 0, 255, 255))
        print(pid, "points", len(xy), "bbox", [round(v) for v in bbox])

    with open(os.path.join(PROJ, "js", "shapes.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by build_shapes.py from 'Bioimmersion Background Photo masks.svg'. Do not edit by hand.\n")
        f.write("window.PLATE = { width: %d, height: %d, src: 'assets/plate.jpg' };\n" % (W, H))
        f.write("window.SHAPES = " + json.dumps(shapes, indent=1) + ";\n")

    plate = photo.resize((3600, round(3600 * H / W)), Image.LANCZOS)
    plate.save(os.path.join(PROJ, "assets", "plate.jpg"), quality=84, optimize=True, progressive=True)
    if "--debug" in sys.argv:
        debug.convert("RGB").save(os.path.join(os.path.dirname(__file__), "outlines_debug.jpg"), quality=80)


if __name__ == "__main__":
    main()
