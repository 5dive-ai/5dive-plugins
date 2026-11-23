#!/usr/bin/env python3
"""Read an Android screen (a uiautomator dump) as controls with refs.

  ui.py snapshot <dump.xml> <refs.json> [--interactive] [--json]
      print the screen, one control per line, and save each ref's node
  ui.py resolve <refs.json> <ref> <dump.xml>
      find the ref's control (e5, or by name: button/Send) on a FRESH dump; print JSON {x, y, label, role,
      kind, value, moved, stale}
  ui.py at <dump.xml> <x> <y>
      the control a tap at that point would hit, same JSON as resolve
  ui.py classify <label>
      print the kind a tap on that label is (pay|publish|send|delete) or ""

Standard library only: the box needs python3 and nothing else.
"""
import json
import re
import sys
import time
import xml.etree.ElementTree as ET

BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")

# What a tap on a control would do, read off its words. Checked in this order,
# so "Delete and send" is a delete. Words a person sees on a phone in the
# languages our owners use; a resource id is split into words too, so
# "btn_send" and "sendButton" count.
KINDS = [
    # Money-bearing sends come first: "Send money" in a payment app is a payment,
    # not a message, and standard lets sends through.
    ("pay", r"send money|send payment|send funds|request money|withdraw|"
            r"geld senden|geld überweisen|überweisen|überweisung|"
            r"отправить деньги|перевод|"
            r"enviar dinero|transferir|transferencia|envoyer de l['’ ]?argent|virement|"
            r"(?:send|senden|отправить|enviar|envoyer)\s*(?:[$€£₽]|usd|eur|gbp|rub)\s*\d+|"
            r"(?:send|senden|отправить|enviar|envoyer)\s+\d+(?:[.,]\d+)?\s*(?:[$€£₽]|usd|eur|gbp|rub)|"
            r"pay|pay now|buy|buy now|purchase|checkout|check out|place order|order now|"
            r"subscribe|donate|top up|transfer|confirm payment|"
            r"оплатить|оплата|купить|заказать|перевести|"
            r"kaufen|bezahlen|jetzt kaufen|pagar|comprar|payer|acheter"),
    ("delete", r"delete|remove|trash|discard|erase|uninstall|unsend|clear chat|"
               r"удалить|löschen|eliminar|borrar|supprimer"),
    ("publish", r"post|publish|tweet|upload|go live|"
                r"опубликовать|veröffentlichen|publicar|publier"),
    ("send", r"send|send message|отправить|senden|enviar|envoyer"),
]
KIND_RES = [(k, re.compile(r"(?<![\w])(?:%s)(?![\w])" % words, re.I)) for k, words in KINDS]


def words_of(*parts):
    out = []
    for p in parts:
        if not p:
            continue
        p = p.rsplit("/", 1)[-1]                      # com.app:id/send_btn -> send_btn
        p = re.sub(r"([a-z])([A-Z])", r"\1 \2", p)   # sendButton -> send Button
        out.append(re.sub(r"[_\-.]+", " ", p))
    return " ".join(out)


def own_words(n):
    """The words a control carries ITSELF. A clickable row borrows its children's
    text for its label, and "Allow Contacts to send you notifications?" on a
    dialog is not a Send button; a sentence is not a button label either."""
    own = n.get("desc") or (n.get("text") if n.get("role") != "textbox" else "") or ""
    if len(own.split()) > 5:
        own = ""
    return own, n.get("rid", "")


def classify(*parts):
    text = words_of(*parts)
    for kind, rx in KIND_RES:
        if rx.search(text):
            return kind
    return ""


def bounds_of(node):
    m = BOUNDS.match(node.get("bounds", ""))
    return [int(v) for v in m.groups()] if m else None


def role_of(n):
    cls = n.get("class", "")
    short = cls.rsplit(".", 1)[-1]
    if "EditText" in short or "AutoCompleteTextView" in short:
        return "textbox"
    if short in ("Switch", "SwitchCompat", "ToggleButton"):
        return "switch"
    if short in ("CheckBox", "CheckedTextView") or n.get("checkable") == "true":
        return "checkbox"
    if short == "RadioButton":
        return "radio"
    if n.get("scrollable") == "true":
        return "list"
    if "Button" in short or n.get("clickable") == "true" or n.get("long-clickable") == "true":
        return "button"
    if "Image" in short:
        return "image"
    return "text"


def interactive(n):
    return (role_of(n) in ("textbox", "switch", "checkbox", "radio", "list", "button")
            and n.get("enabled", "true") == "true")


def inner_text(n, limit=80):
    """The words inside a control that carries none itself (a clickable row)."""
    bits = []
    for d in n.iter():
        if d is n:
            continue
        t = (d.get("text") or d.get("content-desc") or "").strip()
        if t and t not in bits:
            bits.append(t)
        if sum(len(b) for b in bits) >= limit:
            break
    s = " · ".join(bits)
    return s[:limit] + ("…" if len(s) > limit else "")


def label_of(n, role):
    desc = (n.get("content-desc") or "").strip()
    text = (n.get("text") or "").strip()
    hint = (n.get("hint") or "").strip()
    if role == "textbox":
        # In a text box the text is what was typed, or, while it is empty, its
        # hint: a dump does not say which (no hint attribute before Android 14).
        # So a box with no name of its own is shown by what is visible in it.
        return desc or hint or words_of(n.get("resource-id", "")) or text or "text box"
    return desc or text or inner_text(n) or words_of(n.get("resource-id", ""))


def walk(root, only_interactive):
    """Every node worth a line, in screen order, with what a ref needs."""
    out = []
    for n in root.iter("node"):
        b = bounds_of(n)
        if not b or b[2] <= b[0] or b[3] <= b[1] or b[2] <= 0 or b[3] <= 0:
            continue
        role = role_of(n)
        act = interactive(n)
        text = (n.get("text") or "").strip()
        desc = (n.get("content-desc") or "").strip()
        if not act and (only_interactive or not (text or desc)):
            continue
        label = label_of(n, role)
        if not act and not label:
            continue
        flat = lambda v: " ".join(v.split())
        out.append({
            "role": role if act else ("image" if role == "image" else "text"),
            "label": flat(label),
            "value": flat(text) if role == "textbox" else "",
            "rid": n.get("resource-id", ""),
            "cls": n.get("class", ""),
            "desc": desc,
            "text": text,
            "pkg": n.get("package", ""),
            "bounds": b,
            "password": n.get("password") == "true",
            "checked": n.get("checked") == "true" if role in ("switch", "checkbox", "radio") else None,
            "focused": n.get("focused") == "true",
            "interactive": act,
        })
    return out


def load(path):
    try:
        return ET.parse(path).getroot()
    except (ET.ParseError, OSError) as e:
        sys.exit("ui.py: cannot read the screen dump %s: %s" % (path, e))


def cmd_snapshot(dump, refs_path, only_interactive, as_json):
    root = load(dump)
    # Refs are numbered over the whole screen, and --interactive only hides the
    # plain text, so e5 names the same control whichever view the agent read.
    nodes = walk(root, False)
    refs, lines = {}, []
    pkg = next((n["pkg"] for n in nodes if n["pkg"]), "")
    for i, n in enumerate(nodes, 1):
        ref = "e%d" % i
        n["kind"] = classify(*own_words(n)) if n["interactive"] else ""
        refs[ref] = n
        line = "[%s] %s \"%s\"" % (ref, n["role"], n["label"])
        if n["role"] == "textbox" and n["value"] and n["value"] != n["label"]:
            line += " = \"%s\"" % ("••••" if n["password"] else n["value"])
        if n["checked"] is not None:
            line += " (on)" if n["checked"] else " (off)"
        if n["focused"]:
            line += " (focused)"
        if n["kind"]:
            line += "  ⚠ %s" % n["kind"]
        if n["interactive"] or not only_interactive:
            lines.append(line)
    with open(refs_path, "w") as f:
        json.dump({"at": int(time.time()), "app": pkg, "refs": refs}, f)
    if as_json:
        print(json.dumps({"app": pkg, "controls": [dict(ref=r, **{k: v for k, v in n.items() if k != "password"})
                                                   for r, n in refs.items() if n["interactive"] or not only_interactive]}))
        return
    print("app: %s" % (pkg or "?"))
    if not lines:
        print("(nothing on screen it can read: the screen may be off or locked, or the app draws "
              "without accessibility labels; take a screenshot)")
    print("\n".join(lines))


def center(b):
    return (b[0] + b[2]) // 2, (b[1] + b[3]) // 2


def resolve_named(ref, dump):
    """A ref by name, role/label ("button/Send", "textbox/Message"): found on the
    screen as it is NOW, so it survives the renumbering a changed screen causes.
    Exact label first, then one that starts with it; topmost wins."""
    role, _, want = ref.partition("/")
    nodes = [n for n in walk(load(dump), False) if n["interactive"] and role in (n["role"], "*")]
    for test in (lambda l: l == want, lambda l: l.casefold() == want.casefold(),
                 lambda l: l.casefold().startswith(want.casefold())):
        hits = [n for n in nodes if test(n["label"])]
        if hits:
            n = min(hits, key=lambda n: (n["bounds"][1], n["bounds"][0]))
            x, y = center(n["bounds"])
            print(json.dumps({"x": x, "y": y, "label": n["label"], "role": n["role"], "value": n["value"],
                              "kind": classify(*own_words(n)), "moved": False, "stale": False}))
            return
    sys.exit("ui.py: no %s \"%s\" on the screen now — take a snapshot and pick a ref from it" % (role, want))


def cmd_resolve(refs_path, ref, dump):
    if "/" in ref:
        return resolve_named(ref, dump)
    try:
        with open(refs_path) as f:
            saved = json.load(f)["refs"][ref]
    except (OSError, KeyError, ValueError):
        sys.exit("ui.py: no ref %s in the last snapshot — take a snapshot first (5dive phone snapshot)" % ref)
    nodes = walk(load(dump), False)
    ox, oy = center(saved["bounds"])

    def score(n):
        s = 0
        if saved["rid"] and n["rid"] == saved["rid"]:
            s += 4
        if n["cls"] == saved["cls"]:
            s += 1
        if saved["desc"] and n["desc"] == saved["desc"]:
            s += 3
        if saved["role"] != "textbox" and saved["text"] and n["text"] == saved["text"]:
            s += 3
        if n["label"] == saved["label"]:
            s += 2
        return s

    best, best_s, best_d = None, 0, None
    for n in nodes:
        s = score(n)
        if s < 3:
            continue
        x, y = center(n["bounds"])
        d = abs(x - ox) + abs(y - oy)
        if s > best_s or (s == best_s and d < best_d):
            best, best_s, best_d = n, s, d
    stale = best is None
    n = saved if stale else best
    x, y = center(n["bounds"])
    print(json.dumps({
        "x": x, "y": y, "label": n["label"], "role": n["role"], "value": n.get("value", ""),
        "kind": classify(*own_words(n)) if n.get("interactive", True) else "",
        "moved": (not stale) and (x, y) != (ox, oy), "stale": stale,
    }))


def cmd_at(dump, x, y):
    """The smallest control under a point: what a tap there would hit."""
    hit = None
    for n in walk(load(dump), False):
        b = n["bounds"]
        if n["interactive"] and b[0] <= x < b[2] and b[1] <= y < b[3]:
            if hit is None or (b[2] - b[0]) * (b[3] - b[1]) < (hit["bounds"][2] - hit["bounds"][0]) * (hit["bounds"][3] - hit["bounds"][1]):
                hit = n
    if hit is None:
        print(json.dumps({"x": x, "y": y, "label": "", "role": "", "value": "", "kind": "", "moved": False, "stale": False}))
        return
    print(json.dumps({"x": x, "y": y, "label": hit["label"], "role": hit["role"], "value": hit["value"],
                      "kind": classify(*own_words(hit)), "moved": False, "stale": False}))


def main(argv):
    if len(argv) >= 3 and argv[1] == "snapshot":
        cmd_snapshot(argv[2], argv[3], "--interactive" in argv[4:], "--json" in argv[4:])
    elif len(argv) == 5 and argv[1] == "resolve":
        cmd_resolve(argv[2], argv[3], argv[4])
    elif len(argv) == 5 and argv[1] == "at":
        cmd_at(argv[2], int(argv[3]), int(argv[4]))
    elif len(argv) >= 2 and argv[1] == "classify":
        print(classify(" ".join(argv[2:])))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
