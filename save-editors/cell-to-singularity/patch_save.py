#!/usr/bin/env python3

import sys, os, shutil

# =========================== WHAT TO CHANGE ===========================
# Use the currency NAME and the new value (number as a string; "1e12" ok).
CHANGES = {
    "darwinium": "10000000000",
    # "metabits": "1000000000",
    # "mutagen": "1000000",
    # "fossils": "1e12",
    # "idea_metabits": "1000000",
    # "entropy": "1e40",
    # "ideas": "1e20",
}

DEFAULT_FILES = [
    "savedGames.gd",
    "savedGames2.gd",
    "savedGamesDeepBackup.gd",
    "savedGamesBackup_1.gd",
]
# ======================================================================

CURRENCY_KEYS = {
    "entropy":       "bank",
    "ideas":         "bank_b",
    "darwinium":     "bank_c",
    "metabits":      "bank_d",
    "mutagen":       "bank_e",
    "fossils":       "bank_f",
    "idea_metabits": "bank_g",
    "bank_h":        "bank_h", # purpose not confirmed yet
}

ALL_BANK_KEYS = ["bank", "bank_b", "bank_c", "bank_d",
                 "bank_e", "bank_f", "bank_g", "bank_h"]


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_varint(data, p):
    val = shift = 0
    while True:
        b = data[p]; p += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, p
        shift += 7


def _value_span(data: bytes, key: str):
    kb = key.encode()
    needle = bytes([len(kb)]) + kb
    i = data.find(needle)
    if i < 0:
        raise KeyError("key %r not found" % key)
    p = i + len(needle)
    if data[p] != 0x06:
        raise ValueError("value after key %r is not a string (%#x)" % (key, data[p]))
    p += 1 + 4
    ln, content_start = read_varint(data, p)
    content_end = content_start + ln
    old = data[content_start:content_end].decode("utf-8", "replace")
    return p, content_end, old


def set_currency(data: bytes, key: str, new_value: str):
    start, content_end, old = _value_span(data, key)
    nv = new_value.encode()
    return data[:start] + varint(len(nv)) + nv + data[content_end:], old


def read_currency(data: bytes, key: str):
    try:
        return _value_span(data, key)[2]
    except KeyError:
        return None


def resolve(name: str) -> str:
    return CURRENCY_KEYS.get(name, name)


def show(path):
    data = open(path, "rb").read()
    name_by_key = {v: k for k, v in CURRENCY_KEYS.items() if v.startswith("bank")}
    print("\n%s:" % path)
    for k in ALL_BANK_KEYS:
        val = read_currency(data, k)
        if val is None:
            continue
        label = name_by_key.get(k, "?")
        print("  %-8s (%-13s) = %s" % (k, label, val))


def patch_file(path, changes, make_backup=True):
    data = open(path, "rb").read()
    applied = {}
    for name, val in changes.items():
        key = resolve(name)
        data, old = set_currency(data, key, val)
        applied[name] = (old, val)
    if make_backup:
        shutil.copy2(path, path + ".bak")
    with open(path, "wb") as f:
        f.write(data)
    return applied


def main():
    args = sys.argv[1:]
    do_show = "--show" in args
    files = [a for a in args if not a.startswith("--")] or DEFAULT_FILES

    if do_show:
        for f in files:
            if os.path.exists(f):
                show(f)
            else:
                print("no such file: %s" % f)
        return

    for f in files:
        if not os.path.exists(f):
            print("skip (missing): %s" % f)
            continue
        try:
            applied = patch_file(f, CHANGES)
            for name, (old, new) in applied.items():
                print("%s: %s (%s)  %r -> %r" % (f, name, resolve(name), old, new))
        except KeyError as e:
            print("%s: %s - left unchanged" % (f, e))


if __name__ == "__main__":
    main()
