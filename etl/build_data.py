#!/usr/bin/env python3
"""
FolioLens ETL — runs on a schedule via GitHub Actions.

Fetches each portfolio's transactions from the existing Google Apps Script
backend, fetches live + historical NAVs directly from mfapi.in (server-side,
so no CORS proxy is needed), computes XIRR / year-wise growth / nature-wise
allocation / gainers-losers / SWP health, and writes the result to data.json
at the repo root. The frontend reads that single static file instead of
doing all this work in the browser on every page load.
"""
import json
import re
import sys
import time
from datetime import date, datetime, timedelta

import requests

API_URL = "https://script.google.com/macros/s/AKfycbzZrng_0FuzFdh-Iepf98O2FOTnesTCie9zlCfSXS_3DBc0w1-fRj41FARj9fupo5oM/exec"

PORTFOLIOS = [
    {"key": "s", "sheet": "Saketh", "label": "Saketh", "accent": "#22d3ee", "swp": False},
    {"key": "su", "sheet": "Suneetha", "label": "Suneetha", "accent": "#f5c542", "swp": True},
    {"key": "sa", "sheet": "Samhitha", "label": "Samhitha", "accent": "#d8b4fe", "swp": False},
]

MFAPI_BASE = "https://api.mfapi.in/mf/"

ISIN_SCHEME = {"INF090I01171":100471,"INF179K01608":101762,"INF789F01810":102394,"INF200K01370":102756,"INF174K01211":102875,"INF760K01167":102920,"INF789F01AG5":103098,"INF090I01841":103151,"INF204K01GE7":104637,"INF179K01CR2":105758,"INF090I01981":105817,"INF740K01037":105875,"INF109K01BL4":108466,"INF769K01101":112932,"INF846K01859":114564,"INF740K01LP6":117691,"INF754K01CE0":118624,"INF204K01XF9":118650,"INF204K01E54":118668,"INF179K01UT0":118955,"INF179K01XQ0":118989,"INF179K01XZ1":119062,"INF200K01RY0":119609,"INF174K01JP2":119750,"INF200K01UT4":119800,"INF109K01Y07":120251,"INF109K015K4":120334,"INF109K01S39":120616,"INF966L01689":120828,"INF879O01027":122639,"INF879O01019":122640,"INF179KA1RW5":130503,"INF200KA1473":133858,"INF277K01Z44":135797,"INF205K013T3":145137,"INF194KB1AL4":147946,"INF204KB19V4":148457,"INF109KC1O90":148653,"INF879O01175":148958,"INF109KC1R14":148990,"INF174KA1HV3":149185,"INF179KC1BV9":149366,"INF846K013E0":149383,"INF204KC1BL9":152034}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "FolioLens-ETL/1.0"})

NAV_CACHE = {}  # isin -> (history:list[(iso_date, nav)], scheme_name) | None


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch_json(url, timeout=25):
    """GET a URL and parse JSON, tolerating a JSONP callback(...) wrapper."""
    r = SESSION.get(url, timeout=timeout)
    r.raise_for_status()
    text = r.text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\((\{.*\})\)\s*;?\s*$", text, re.S)
        if m:
            return json.loads(m.group(1))
        raise


def fetch_sheet(sheet_name):
    return fetch_json(f"{API_URL}?sheet={sheet_name}")


def fetch_nav_snapshots():
    try:
        return fetch_json(f"{API_URL}?action=nav_snapshots").get("snapshots", {})
    except Exception as e:
        log(f"  ! nav_snapshots fetch failed: {e}")
        return {}


_AMFI_ISIN_MAP = None  # lazy-loaded once per run, isin -> mfapi scheme code


def get_amfi_isin_map():
    """Fetches AMFI's public scheme index once per run and builds an ISIN -> scheme
    code lookup, for funds not already in the static ISIN_SCHEME map. This is only
    ever used to find the *code* -- the actual NAV always comes from mfapi.in."""
    global _AMFI_ISIN_MAP
    if _AMFI_ISIN_MAP is not None:
        return _AMFI_ISIN_MAP
    _AMFI_ISIN_MAP = {}
    try:
        r = SESSION.get("https://www.amfiindia.com/spages/NAVAll.txt", timeout=30)
        if r.ok:
            for line in r.text.splitlines():
                if ";" not in line:
                    continue
                cols = line.split(";")
                if len(cols) < 4:
                    continue
                code = cols[0].strip()
                if not code.isdigit():
                    continue
                isin_growth = cols[1].strip()
                isin_reinvest = cols[2].strip()
                if isin_growth:
                    _AMFI_ISIN_MAP[isin_growth] = code
                if isin_reinvest:
                    _AMFI_ISIN_MAP[isin_reinvest] = code
            log(f"  AMFI index loaded: {len(_AMFI_ISIN_MAP)} ISINs")
    except Exception as e:
        log(f"  ! AMFI index fetch failed: {e}")
    return _AMFI_ISIN_MAP


def resolve_scheme_code(isin):
    if isin in ISIN_SCHEME:
        return ISIN_SCHEME[isin]
    return get_amfi_isin_map().get(isin)


def fetch_nav_history(isin):
    """Returns (history, scheme_name) where history = [(iso_date, nav), ...] ascending, or None."""
    if isin in NAV_CACHE:
        return NAV_CACHE[isin]
    scheme = resolve_scheme_code(isin)
    result = None
    if scheme:
        try:
            r = SESSION.get(f"{MFAPI_BASE}{scheme}", timeout=25)
            if r.ok:
                j = r.json()
                rows = j.get("data", [])
                hist = []
                for row in rows:
                    try:
                        d, m, y = row["date"].split("-")
                        hist.append((f"{y}-{m}-{d}", float(row["nav"])))
                    except Exception:
                        continue
                hist.sort(key=lambda x: x[0])
                if hist:
                    result = (hist, (j.get("meta") or {}).get("scheme_name", ""))
        except Exception as e:
            log(f"  ! mfapi fetch failed for {isin}: {e}")
    NAV_CACHE[isin] = result
    time.sleep(0.15)  # be polite to the free API
    return result


def to_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def xirr(cashflows):
    """cashflows: list of (date, amount). Negative = money out, positive = money in."""
    cashflows = [(d, a) for d, a in cashflows]
    if len(cashflows) < 2:
        return None
    t0 = cashflows[0][0]

    def npv(r):
        return sum(a / (1 + r) ** ((t - t0).days / 365.0) for t, a in cashflows)

    def dnpv(r):
        return sum(-((t - t0).days / 365.0) * a / (1 + r) ** ((t - t0).days / 365.0 + 1) for t, a in cashflows)

    r = 0.12
    for _ in range(300):
        try:
            n, d = npv(r), dnpv(r)
        except (OverflowError, ZeroDivisionError):
            return None
        if abs(d) < 1e-14:
            break
        nr = r - n / d
        if abs(nr - r) < 1e-10:
            r = nr
            break
        r = max(nr, -0.9999)
    if r != r or r in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    return r * 100


def compute_year_wise(funds, nav_snapshots, today):
    current_year = str(today.year)
    all_years = sorted({t["d"][:4] for f in funds for t in f["txns"]})

    def year_end_nav(f, target_yr):
        if target_yr == current_year:
            return f["liveNav"]
        snap = nav_snapshots.get(f'{f["isin"]}_{target_yr}')
        if snap:
            return snap.get("nav")
        yr_txns = [t for t in f["txns"] if t["d"][:4] <= target_yr]
        return yr_txns[-1]["n"] if yr_txns else None

    out = []
    for yr in all_years:
        is_partial = yr == current_year
        start_val = end_val = 0.0
        for f in funds:
            prev_yr = str(int(yr) - 1)
            start_nav = year_end_nav(f, prev_yr)
            start_units = sum(t["u"] for t in f["txns"] if t["d"][:4] < yr and t["a"] > 0) \
                - sum(abs(t["u"]) for t in f["txns"] if t["d"][:4] < yr and t["a"] < 0)
            if start_nav and start_units > 0:
                start_val += start_units * start_nav
            end_nav = year_end_nav(f, yr)
            end_units = sum(t["u"] for t in f["txns"] if t["d"][:4] <= yr and t["a"] > 0) \
                - sum(abs(t["u"]) for t in f["txns"] if t["d"][:4] <= yr and t["a"] < 0)
            if end_nav and end_units > 0:
                end_val += end_units * end_nav
        fresh_invested = sum(t["a"] for f in funds for t in f["txns"] if t["d"].startswith(yr) and t["a"] > 0)
        withdrawals = sum(abs(t["a"]) for f in funds for t in f["txns"] if t["d"].startswith(yr) and t["a"] < 0)
        abs_gain = end_val - start_val - fresh_invested + withdrawals
        gain_pct = (abs_gain / (start_val + fresh_invested) * 100) if (start_val + fresh_invested) > 0 else 0
        yr_xirr = None
        try:
            jan1 = date(int(yr), 1, 1)
            dec31 = today if is_partial else date(int(yr), 12, 31)
            cf = []
            if start_val > 0:
                cf.append((jan1, -start_val))
            yr_txns = sorted([t for f in funds for t in f["txns"] if t["d"].startswith(yr)], key=lambda t: t["d"])
            for t in yr_txns:
                if t["a"] != 0:
                    cf.append((to_date(t["d"]), -t["a"]))
            if cf and end_val > 0 and (dec31 - cf[0][0]).days >= 30:
                cf.append((dec31, end_val))
                yr_xirr = xirr(cf)
        except Exception as e:
            log(f"  ! year xirr failed for {yr}: {e}")
        out.append({
            "yr": yr, "isPartial": is_partial, "startVal": start_val, "endVal": end_val,
            "freshInvested": fresh_invested, "withdrawals": withdrawals,
            "absGain": abs_gain, "gainPct": gain_pct, "xirr": yr_xirr,
        })
    return out


def trim_history(hist):
    """Keep file size sane: ~1 point/week beyond 400 points, always keep the latest."""
    if len(hist) <= 400:
        return hist
    trimmed = hist[::5]
    if trimmed[-1] != hist[-1]:
        trimmed.append(hist[-1])
    return trimmed


def compute_portfolio(sheet_name, nav_snapshots, today):
    raw = fetch_sheet(sheet_name)
    if raw.get("error"):
        raise RuntimeError(raw["error"])
    funds_in = raw.get("funds", [])

    fund_out = []
    total_inv = total_val = 0.0
    nature_map = {}
    fam_cf = []

    for f in funds_in:
        isin = f["isin"]
        txns = sorted(f.get("txns", []), key=lambda t: t["d"])
        hist_data = fetch_nav_history(isin)
        live_nav = live_date = None
        scheme_name = ""
        hist_trimmed = []
        if hist_data:
            hist, scheme_name = hist_data
            if hist:
                live_date, live_nav = hist[-1]
            hist_trimmed = trim_history(hist)

        nav = live_nav if live_nav else f.get("statementNav", 0)
        is_live = live_nav is not None
        units = f.get("units", 0)
        invested = f.get("invested", 0)
        value = units * nav
        fund_withdrawn = sum(abs(t["a"]) for t in txns if t["a"] < 0)
        gain = (value + fund_withdrawn) - invested
        gain_pct = (gain / invested * 100) if invested else 0

        final_date = today if is_live else (to_date(txns[-1]["d"]) if txns else today)
        cf = [(to_date(t["d"]), -t["a"]) for t in txns] + [(final_date, value)]
        fx = xirr(cf)

        total_buy_units = sum(t["u"] for t in txns if t["a"] > 0)
        avg_nav = (invested / total_buy_units) if total_buy_units else 0

        cat = f.get("cat", "Other")
        nm = nature_map.setdefault(cat, {"value": 0.0, "invested": 0.0, "withdrawn": 0.0, "funds": [], "txns": []})
        nm["value"] += value
        nm["invested"] += sum(t["a"] for t in txns)
        nm["withdrawn"] += fund_withdrawn
        nm["funds"].append(isin)
        nm["txns"].extend(txns)

        total_inv += invested
        total_val += value
        fam_cf.extend([(to_date(t["d"]), -t["a"]) for t in txns])

        fund_out.append({
            "isin": isin, "name": f.get("name") or scheme_name, "cat": cat,
            "units": units, "invested": invested, "statementNav": f.get("statementNav", 0),
            "avgNav": avg_nav, "liveNav": nav, "navDate": live_date or "stmt", "isLive": is_live,
            "value": value, "withdrawn": fund_withdrawn, "gain": gain, "gainPct": gain_pct, "xirr": fx,
            "navHistory": hist_trimmed, "txns": txns,
        })

    all_txns_cf = [(to_date(t["d"]), -t["a"]) for f in fund_out for t in f["txns"]]
    all_txns_cf.append((today, total_val))
    port_xirr = xirr(all_txns_cf)

    total_withdrawn = sum(abs(t["a"]) for f in fund_out for t in f["txns"] if t["a"] < 0)

    nature_out = []
    for cat, d in nature_map.items():
        cat_cf = [(to_date(t["d"]), -t["a"]) for t in d["txns"]] + [(today, d["value"])]
        nature_out.append({
            "cat": cat, "value": d["value"], "invested": d["invested"], "withdrawn": d["withdrawn"],
            "xirr": xirr(cat_cf), "fundCount": len(d["funds"]),
        })
    nature_out.sort(key=lambda x: -x["value"])

    year_wise = compute_year_wise(fund_out, nav_snapshots, today)

    ranked = sorted([f for f in fund_out if f["xirr"] is not None], key=lambda x: -x["xirr"])
    gainers = [{"isin": g["isin"], "name": g["name"], "xirr": g["xirr"]} for g in ranked[:3]]
    losers = [{"isin": l["isin"], "name": l["name"], "xirr": l["xirr"]} for l in list(reversed(ranked))[:3]]

    # True gain = (current value + money already withdrawn) - money invested.
    # Just doing value - invested is wrong for any portfolio with withdrawals (e.g. SWP),
    # since it ignores cash you've already taken out and pockets it as an apparent "loss".
    true_gain = (total_val + total_withdrawn) - total_inv

    return {
        "totals": {"invested": total_inv, "value": total_val, "xirr": port_xirr,
                   "withdrawn": total_withdrawn, "gain": true_gain, "fundCount": len(fund_out)},
        "funds": fund_out, "yearWise": year_wise, "nature": nature_out,
        "gainers": gainers, "losers": losers,
    }, fam_cf


def compute_swp(fund_out, total_value, port_xirr, today):
    all_txns = [t for f in fund_out for t in f["txns"]]
    withdrawals = [t for t in all_txns if t["a"] < 0]
    total_withdrawn = sum(abs(t["a"]) for t in withdrawals)

    current_year = str(today.year)
    yr_withdrawals = [t for t in withdrawals if t["d"][:4] == current_year]
    yr_withdrawn_amt = sum(abs(t["a"]) for t in yr_withdrawals)
    months_elapsed = today.month  # Jan=1 month elapsed ... Dec=12 (full year)
    avg_monthly = (yr_withdrawn_amt / months_elapsed) if months_elapsed > 0 else 0

    runway_months = (total_value / avg_monthly) if avg_monthly > 0 else None
    annual_rate_pct = (avg_monthly * 12 / total_value * 100) if total_value > 0 else 0
    sustainable = (port_xirr is not None) and (annual_rate_pct < port_xirr) if avg_monthly > 0 else None
    return {
        "totalWithdrawn": total_withdrawn, "withdrawalCount": len(withdrawals),
        "avgMonthly": avg_monthly, "runwayMonths": runway_months,
        "annualWithdrawalRatePct": annual_rate_pct, "sustainable": sustainable,
        "yearWithdrawn": yr_withdrawn_amt, "monthsElapsed": months_elapsed, "currentYear": current_year,
    }


def main():
    today = date.today()
    log(f"FolioLens ETL run · {today.isoformat()}")

    log("Fetching NAV snapshots…")
    nav_snapshots = fetch_nav_snapshots()

    portfolios_out = {}
    fam_cf_all = []

    for p in PORTFOLIOS:
        log(f"Processing {p['label']}…")
        try:
            result, fam_cf = compute_portfolio(p["sheet"], nav_snapshots, today)
        except Exception as e:
            log(f"  !! FAILED for {p['label']}: {e}")
            continue
        if p["swp"]:
            result["swp"] = compute_swp(result["funds"], result["totals"]["value"], result["totals"]["xirr"], today)
        result["label"] = p["label"]
        result["accent"] = p["accent"]
        result["swpEnabled"] = p["swp"]
        portfolios_out[p["sheet"]] = result
        fam_cf_all.extend(fam_cf)
        log(f"  OK — {result['totals']['fundCount']} funds, "
            f"value ₹{result['totals']['value']:.0f}, xirr "
            f"{result['totals']['xirr']:.2f}%" if result['totals']['xirr'] is not None else "  OK")

    fam_inv = sum(p["totals"]["invested"] for p in portfolios_out.values())
    fam_val = sum(p["totals"]["value"] for p in portfolios_out.values())
    fam_withdrawn = sum(p["totals"].get("withdrawn", 0) for p in portfolios_out.values())
    fam_cf_all.append((today, fam_val))
    fam_xirr = xirr(fam_cf_all)

    all_funds_combined = [f for p in portfolios_out.values() for f in p["funds"]]
    fam_year_wise = compute_year_wise(all_funds_combined, nav_snapshots, today)

    compare = [{"sheet": sheet, "label": p["label"], "accent": p["accent"],
                "invested": p["totals"]["invested"], "value": p["totals"]["value"],
                "withdrawn": p["totals"].get("withdrawn", 0),
                "xirr": p["totals"]["xirr"]} for sheet, p in portfolios_out.items()]

    output = {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "portfolios": portfolios_out,
        "family": {
            "totals": {"invested": fam_inv, "value": fam_val, "withdrawn": fam_withdrawn,
                       "gain": (fam_val + fam_withdrawn) - fam_inv, "xirr": fam_xirr},
            "yearWise": fam_year_wise, "compare": compare,
        },
    }

    with open("data.json", "w") as fh:
        json.dump(output, fh, separators=(",", ":"))
    log(f"Wrote data.json ({len(json.dumps(output))} bytes)")


if __name__ == "__main__":
    main()
