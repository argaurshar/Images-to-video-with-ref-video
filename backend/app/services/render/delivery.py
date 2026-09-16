"""Stills pack and project record (spec 12.7)."""
from __future__ import annotations

import html
import json
import zipfile
from pathlib import Path

from ... import costs
from ...models import Project
from ...store import abs_path


def stills_pack(p: Project, out: Path) -> Path:
    approved = [s for s in p.stills if s.status == "approved"]
    heroes = [h for h in p.heroes if h.chosen]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for h in heroes:
            z.write(abs_path(h.path), f"hero_{h.cls}{Path(h.path).suffix}")
        for s in approved:
            sh = p.shot(s.shot_n) if s.shot_n else None
            z.write(abs_path(s.path), f"shot_{s.shot_n:02d}_{s.cls}{Path(s.path).suffix}")
        side = {
            "project": p.name, "disclaimer": p.branding.disclaimer, "stage": p.intake.project_stage,
            "stills": [{"file": f"shot_{s.shot_n:02d}_{s.cls}", "shot": s.shot_n, "source_hub": s.source_hub_id,
                        "state": p.shot(s.shot_n).state.model_dump() if s.shot_n else None, "prompt": s.prompt,
                        "audit": s.audit.model_dump()} for s in approved],
        }
        z.writestr("sidecar.json", json.dumps(side, indent=2))
    return out


def project_record(p: Project, out_json: Path, out_html: Path) -> None:
    data = p.model_dump()
    data["cost_summary"] = costs.summary(p)
    out_json.write_text(json.dumps(data, indent=2))
    e = html.escape
    rows = []
    for s in p.plan.shots:
        st = next((x for x in p.stills if x.shot_n == s.n and x.status == "approved"), None)
        c = next((x for x in p.clips if x.shot_n == s.n and x.status == "approved"), None)
        rows.append(f"<tr><td>{s.n}</td><td>{s.cls}</td><td>{e(s.season)} / {e(s.time)}</td><td>{s.scale}</td>"
                    f"<td>{e(s.source_hub_id)}</td><td>{e(s.design_intent)}</td>"
                    f"<td>{(st.audit.rating if st else '-')}</td><td>{('pass' if c and c.qc.passed else ('fail: ' + ', '.join(c.qc.failures)) if c else '-')}</td></tr>")
    prompts = "".join(f"<h4>Shot {s.n} still prompt</h4><pre>{e(next((x.prompt for x in p.stills if x.shot_n == s.n and x.status == 'approved'), ''))}</pre>"
                      f"<h4>Shot {s.n} motion prompt</h4><pre>{e(next((x.prompt for x in p.clips if x.shot_n == s.n and x.status == 'approved'), ''))}</pre>"
                      for s in p.plan.shots)
    approvals = "".join(f"<li>{e(a['ts'])} — {e(a['what'])} {e(json.dumps(a.get('detail'))) if a.get('detail') else ''}</li>" for a in p.approvals)
    ledger = "".join(f"<tr><td>{e(l.ts)}</td><td>{e(l.kind)}</td><td>{l.units}</td><td>{l.cost:.2f}</td><td>{e(l.note)}</td></tr>" for l in p.ledger)
    hubs = "".join(f"<li><b>{e(h.id)}</b> {e(h.filename)} · {h.cls} · faces {e(h.camera_faces or 'not stated')} · {e(h.materials)}</li>" for h in p.hubs)
    out_html.write_text(f"""<!doctype html><html><head><meta charset="utf-8"><title>Project record — {e(p.name)}</title>
<style>body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#222}}
table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border:1px solid #ddd;padding:6px}}pre{{white-space:pre-wrap;background:#f6f6f6;padding:10px;font-size:12px}}</style></head><body>
<h1>Project record: {e(p.name)}</h1>
<p><b>{e(p.branding.disclaimer)}</b></p>
<p>Location: {e(p.intake.location)} · Stage: {e(p.intake.project_stage)} · End use: {e(p.intake.end_use)} · Aspect: {e(p.intake.aspect)} · Provider: {e(p.clips[0].provider if p.clips else '')}</p>
<h2>Hub renders (never modified)</h2><ul>{hubs}</ul>
<h2>Design intents</h2><ul>{''.join(f'<li>{e(t)}</li>' for t in p.intake.design_intents)}</ul>
<h2>Shot plan and outcomes</h2>
<table><tr><th>#</th><th>Class</th><th>Season / time</th><th>Scale</th><th>Source</th><th>Design intent</th><th>Still audit</th><th>Clip QC</th></tr>{''.join(rows)}</table>
<h2>Approvals</h2><ul>{approvals}</ul>
<h2>Spend</h2><p>Total {p.spend():.2f} against a budget of {p.budget.total:.2f}</p>
<table><tr><th>When</th><th>Kind</th><th>Units</th><th>Cost</th><th>Note</th></tr>{ledger}</table>
<h2>Prompts</h2>{prompts}
</body></html>""")
