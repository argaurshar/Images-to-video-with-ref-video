"""Pydantic models for a project. The whole project state is one document
persisted as JSON, which keeps the record (Part 12.7 of the spec) trivial:
the project file is the record."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

AssetClass = Literal["exterior", "interior"]
Aspect = Literal["16:9", "9:16", "1:1", "4:5"]
Scale = Literal["aerial", "wide", "medium", "detail", "macro"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class HubImage(BaseModel):
    id: str
    filename: str
    path: str
    cls: AssetClass = "exterior"
    width: int = 0
    height: int = 0
    detected: dict[str, Any] = Field(default_factory=dict)
    camera_faces: Optional[str] = None  # N, NE, E, SE, S, SW, W, NW
    continuity_group: Optional[str] = None
    label: str = ""
    materials: str = ""  # named finishes, typed by the designer, fed to every prompt
    elements: str = ""   # enumerated fixed elements for the prompt's sacred list


class Intake(BaseModel):
    route: Literal["reference", "brief"] = "brief"
    aspect: Aspect = "16:9"
    seasons: list[str] = Field(default_factory=lambda: ["summer"])
    time_arc: Literal["dawn_to_night", "single", "golden_hour", "night"] = "dawn_to_night"
    single_time: Optional[str] = None
    mood: Literal["serene", "moody", "warm", "bold"] = "serene"
    people: Literal["none", "scale_figure", "lifestyle"] = "scale_figure"
    length_shots: int = 5
    location: str = ""
    project_stage: Literal[
        "concept", "design_development", "planning", "construction_docs", "completed"
    ] = "design_development"
    end_use: Literal[
        "client_presentation", "planning_consultation", "website", "social", "awards", "developer_marketing"
    ] = "client_presentation"
    interior_emphasis: Optional[
        Literal["daylight", "night", "seasonal_view", "lived_in"]
    ] = None
    design_intents: list[str] = Field(default_factory=list)
    project_name: str = ""
    practice_name: str = ""


class ChapterState(BaseModel):
    season: str
    time: str
    weather: str
    lights_on: bool
    month: str = ""
    precipitation: bool = False


class Shot(BaseModel):
    n: int
    cls: AssetClass
    chapter: int
    season: str
    time: str
    scale: Scale
    framing: str
    source_hub_id: str
    motion: str
    human_beat: str = "none"
    design_intent: str = ""
    beat: str = ""  # approach / enter / dwell / detail / return / closer
    heavy: bool = False
    duration: float = 5.0  # seconds; reference-driven on Route A
    state: ChapterState
    sun_side: str = "camera-left"
    locked: bool = False
    rederive_state: bool = False   # transient: the editor changed season or time


class ShotPlan(BaseModel):
    approved: bool = False
    reference_driven: bool = False
    shots: list[Shot] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    rationale: str = ""


class AuditReport(BaseModel):
    rating: Literal["pass", "minor", "fail", "not_run"] = "not_run"
    structure_similarity: float = 0.0
    new_edge_fraction: float = 0.0
    luminance_shift: float = 0.0
    hue_shift_deg: float = 0.0
    driver: str = ""
    checklist: list[str] = Field(default_factory=list)
    notes: str = ""


class Generated(BaseModel):
    id: str
    shot_n: Optional[int] = None
    cls: AssetClass = "exterior"
    source_hub_id: str = ""
    attempt: int = 1
    path: str = ""
    thumb: str = ""
    prompt: str = ""
    negative: str = ""
    provider: str = ""
    provider_id: str = ""
    cost: float = 0.0
    created_at: str = Field(default_factory=now_iso)
    status: Literal["pending", "approved", "rejected", "cut", "failed"] = "pending"
    note: str = ""


class Hero(Generated):
    variant: int = 1
    audit: AuditReport = Field(default_factory=AuditReport)
    chosen: bool = False


class Still(Generated):
    audit: AuditReport = Field(default_factory=AuditReport)


class QCReport(BaseModel):
    ran: bool = False
    motion_score: float = 0.0
    frozen_ratio: float = 0.0
    particle_density: float = 0.0
    geometry_similarity: float = 1.0
    regions: dict[str, float] = Field(default_factory=dict)
    vertical_drift_deg: float = 0.0
    vertical_measured: bool = True   # False when no building verticals were found
    luminance_drift: float = 0.0
    hue_drift_deg: float = 0.0
    text_suspect: bool = False
    frames_sampled: int = 0
    passed: bool = False
    failures: list[str] = Field(default_factory=list)
    interpretation: str = ""


class Clip(Generated):
    still_id: str = ""
    mode: str = "initial"   # initial | camera_softer | lighter_cues | dry | notes
    duration: float = 5.0
    qc: QCReport = Field(default_factory=QCReport)
    mean_brightness: float = 0.0


class ReferenceShot(BaseModel):
    index: int
    start_s: float
    end_s: float
    duration_s: float
    scale: str
    brightness: float
    camera_move: str
    setting: str


class ReferenceAnalysis(BaseModel):
    filename: str = ""
    duration_s: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    aspect: str = ""
    shot_count: int = 0
    mean_shot_length_s: float = 0.0
    shots: list[ReferenceShot] = Field(default_factory=list)
    light_arc: list[float] = Field(default_factory=list)
    mean_brightness: float = 0.0
    mean_saturation: float = 0.0
    warmth: float = 0.0
    shadow_floor: float = 0.0
    highlight_ceiling: float = 0.0
    weather_density: float = 0.0
    sky_band_density: float = 0.0
    has_audio: bool = False
    scale_changes_per_shot: float = 0.0
    max_same_scale_run: int = 0
    inside_outside_pattern: str = ""
    caveat: str = ""


class Budget(BaseModel):
    confirmed: bool = False
    hero_images: int = 0
    stills: int = 0
    clips: int = 0
    image_cost: float = 0.0
    video_cost: float = 0.0
    reserve: float = 0.0
    total: float = 0.0


class LedgerEntry(BaseModel):
    ts: str = Field(default_factory=now_iso)
    kind: str
    units: int = 1
    cost: float = 0.0
    note: str = ""


class Branding(BaseModel):
    title_position: Literal["start", "end", "both", "none"] = "start"
    project_name: str = ""
    practice_name: str = ""
    location_line: str = ""
    subtitle: str = ""
    year: str = ""
    stage_stamp: str = ""
    disclaimer: str = "Artist's impression. Not a daylight study or planning drawing."
    disclaimer_every_frame: bool = False
    style: Literal["minimal", "card", "lower_third"] = "minimal"
    logo_path: str = ""


class Sequence(BaseModel):
    order: list[str] = Field(default_factory=list)
    suggested_order: list[str] = Field(default_factory=list)
    rationale: str = ""
    warnings: list[str] = Field(default_factory=list)


class Deliverables(BaseModel):
    film: str = ""
    crops: dict[str, str] = Field(default_factory=dict)
    stills_pack: str = ""
    record_json: str = ""
    record_html: str = ""
    verification: dict[str, Any] = Field(default_factory=dict)


class Project(BaseModel):
    id: str
    name: str
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    stage: str = "intake"
    hubs: list[HubImage] = Field(default_factory=list)
    intake: Intake = Field(default_factory=Intake)
    location_profile: dict[str, Any] = Field(default_factory=dict)
    reference: Optional[ReferenceAnalysis] = None
    budget: Budget = Field(default_factory=Budget)
    plan: ShotPlan = Field(default_factory=ShotPlan)
    heroes: list[Hero] = Field(default_factory=list)
    stills: list[Still] = Field(default_factory=list)
    clips: list[Clip] = Field(default_factory=list)
    sequence: Sequence = Field(default_factory=Sequence)
    branding: Branding = Field(default_factory=Branding)
    deliverables: Deliverables = Field(default_factory=Deliverables)
    ledger: list[LedgerEntry] = Field(default_factory=list)
    approvals: list[dict[str, Any]] = Field(default_factory=list)
    audio_beds: dict[str, str] = Field(default_factory=dict)

    # convenience -----------------------------------------------------
    def hub(self, hub_id: str) -> HubImage:
        for h in self.hubs:
            if h.id == hub_id:
                return h
        raise KeyError(hub_id)

    def shot(self, n: int) -> Shot:
        for s in self.plan.shots:
            if s.n == n:
                return s
        raise KeyError(n)

    def spend(self) -> float:
        return round(sum(e.cost for e in self.ledger), 2)

    def record_approval(self, what: str, detail: Any = None) -> None:
        self.approvals.append({"ts": now_iso(), "what": what, "detail": detail})
