#!/usr/bin/env python3
"""
OneClickitLeads — offline bulk scrubber
======================================

Use this for purchased lead lists, CSV dumps from ZoomInfo/Apollo, or anything
too big to run through the Next.js API synchronously.

Usage:
    python scrub_cli.py --input leads_in.csv --output clean.csv --rejects rejects.csv

What it does:
    1. Normalize emails (lowercase, strip +tag for dedupe)
    2. Syntax check  (RFC 5322)
    3. Disposable domain check
    4. MX record check
    5. SMTP verify via NeverBounce or ZeroBounce  (if API key in env)
    6. Dedupe  (within the batch)
    7. Suppression filter   (against an optional suppressions CSV)
    8. Phone normalization to E.164

Outputs:
    clean.csv    — only rows that passed every gate, ready for smartly.io
    rejects.csv  — rejected rows with reason
    report.json  — counts + top reject reasons

Requires: phonenumbers, dnspython, requests
    pip install phonenumbers dnspython requests
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field, asdict

try:
    import dns.resolver
except ImportError:
    dns = None

try:
    import phonenumbers
except ImportError:
    phonenumbers = None

try:
    import requests
except ImportError:
    requests = None

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]"
    r"(?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)

DISPOSABLE = {
    "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
    "yopmail.com", "trashmail.com", "getnada.com", "throwaway.email",
    "sharklasers.com", "maildrop.cc", "dispostable.com",
}


@dataclass
class Result:
    email: str
    normalized: str
    phone: str | None
    phone_e164: str | None
    syntax_valid: bool = False
    mx_valid: bool = False
    smtp_valid: bool = False
    is_disposable: bool = False
    is_duplicate: bool = False
    is_suppressed: bool = False
    score: int = 0
    reject_reason: str | None = None
    extras: dict = field(default_factory=dict)


def normalize_email(raw: str) -> str:
    if not raw:
        return ""
    e = raw.strip().lower()
    if "@" not in e:
        return e
    local, domain = e.split("@", 1)
    local = local.split("+", 1)[0]
    return f"{local}@{domain}"


def syntax_ok(email: str) -> bool:
    return bool(EMAIL_RE.match(email))


def mx_ok(email: str) -> bool:
    if dns is None:
        return True  # can't check — don't block
    domain = email.split("@", 1)[-1]
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=5)
        return len(list(answers)) > 0
    except Exception:
        return False


def smtp_verify(email: str) -> bool | None:
    """Returns True/False, or None if we couldn't verify."""
    if requests is None:
        return None
    nb = os.getenv("NEVERBOUNCE_API_KEY")
    zb = os.getenv("ZEROBOUNCE_API_KEY")
    try:
        if nb:
            r = requests.get(
                "https://api.neverbounce.com/v4/single/check",
                params={"key": nb, "email": email},
                timeout=10,
            ).json()
            return r.get("result") == "valid"
        if zb:
            r = requests.get(
                "https://api.zerobounce.net/v2/validate",
                params={"api_key": zb, "email": email},
                timeout=10,
            ).json()
            return r.get("status") == "valid"
    except Exception:
        return None
    return None


def normalize_phone(raw: str, default_region: str = "US") -> str | None:
    if not raw or phonenumbers is None:
        return None
    try:
        n = phonenumbers.parse(raw, default_region)
        if not phonenumbers.is_valid_number(n):
            return None
        return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        return None


def email_hash(email: str) -> str:
    return hashlib.sha256(email.encode("utf-8")).hexdigest()


def scrub_row(row: dict, suppressions: set[str], seen: set[str]) -> Result:
    raw_email = (row.get("email") or "").strip()
    raw_phone = (row.get("phone") or "").strip()
    res = Result(
        email=raw_email,
        normalized=normalize_email(raw_email),
        phone=raw_phone or None,
        phone_e164=normalize_phone(raw_phone) if raw_phone else None,
        extras={k: v for k, v in row.items() if k not in ("email", "phone")},
    )

    if not res.normalized:
        res.reject_reason = "missing_email"
        return res

    if not syntax_ok(res.normalized):
        res.reject_reason = "bad_syntax"
        return res
    res.syntax_valid = True

    domain = res.normalized.split("@", 1)[-1]
    if domain in DISPOSABLE:
        res.is_disposable = True
        res.reject_reason = "disposable_domain"
        return res

    if res.normalized in suppressions:
        res.is_suppressed = True
        res.reject_reason = "suppressed"
        return res

    h = email_hash(res.normalized)
    if h in seen:
        res.is_duplicate = True
        res.reject_reason = "duplicate"
        return res
    seen.add(h)

    if not mx_ok(res.normalized):
        res.reject_reason = "no_mx"
        res.score = 10
        return res
    res.mx_valid = True

    smtp = smtp_verify(res.normalized)
    if smtp is True:
        res.smtp_valid = True
        res.score = 100
    elif smtp is False:
        res.reject_reason = "smtp_failed"
        res.score = 30
        return res
    else:
        # smtp check skipped (no key) → MX-only pass
        res.score = 60

    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", default="clean.csv")
    ap.add_argument("--rejects", default="rejects.csv")
    ap.add_argument("--suppressions", help="optional CSV with one email per line")
    ap.add_argument("--report", default="report.json")
    args = ap.parse_args()

    suppressions: set[str] = set()
    if args.suppressions and os.path.exists(args.suppressions):
        with open(args.suppressions, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if row:
                    suppressions.add(normalize_email(row[0]))

    seen: set[str] = set()
    clean_rows: list[dict] = []
    reject_rows: list[dict] = []
    reasons: Counter[str] = Counter()

    with open(args.input, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            r = scrub_row(row, suppressions, seen)
            base = {
                "email": r.normalized,
                "phone_e164": r.phone_e164 or "",
                "score": r.score,
                "syntax_valid": r.syntax_valid,
                "mx_valid": r.mx_valid,
                "smtp_valid": r.smtp_valid,
                "is_disposable": r.is_disposable,
                "is_duplicate": r.is_duplicate,
                "is_suppressed": r.is_suppressed,
                "reject_reason": r.reject_reason or "",
                **r.extras,
            }
            if r.reject_reason:
                reasons[r.reject_reason] += 1
                reject_rows.append(base)
            else:
                clean_rows.append(base)

    def dump(path: str, rows: list[dict]):
        if not rows:
            open(path, "w", encoding="utf-8").close()
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    dump(args.output, clean_rows)
    dump(args.rejects, reject_rows)

    report = {
        "input_rows": len(clean_rows) + len(reject_rows),
        "clean_rows": len(clean_rows),
        "rejects": len(reject_rows),
        "reject_reasons": reasons.most_common(),
        "smtp_verified": sum(1 for r in clean_rows if r["smtp_valid"]),
    }
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
