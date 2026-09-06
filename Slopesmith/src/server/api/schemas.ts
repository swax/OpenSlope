import { jsonResponse, type ApiHandler } from './common';
import { link, type HateoasEnvelope } from './hateoas';

/**
 * JSON Schemas for the request bodies and register values the HATEOAS actions point at (docs/052).
 *
 * Hand-written literals rather than generated: the server carries no schema library, and the documents these
 * describe are TypeScript interfaces whose real specification is the prose in `core/doc/types.ts`. Each
 * schema distils that prose into the fields an agent must supply and the constraints it cannot guess —
 * enough to author with, while the interface files remain the source of truth. A schema here is deliberately
 * permissive (`additionalProperties: true`) so a document field added tomorrow does not make every existing
 * body invalid against a stale copy of this registry.
 *
 * Served at `GET /api/schemas` (the index) and `GET /api/schemas/<Name>`. Actions reference these URLs in
 * their `schema` field; the inline `body` stub on the action is the common case, and this is the fallback for
 * an unfamiliar or complex body.
 */

const V3 = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: 'A point or vector: [x, y, z] in editor/data space — metres, Y up.',
};

/** A placement's position as a register WRITE accepts it: the stored [x, y, z], or one of the intent forms
 *  the server resolves before landing (docs/052, intents.ts). A read always answers the stored form. */
const PLACED_POS = {
  description: 'Where it stands. [x, y, z] in editor metres lands as sent. [x, null, z] seats Y on the '
    + 'terrain under (x, z); [x, "+1.5", z] a height above it ("-0.2" below). { station, lateral, above } is '
    + 'the run\'s own frame: station = metres along the course line from knot 0 (GET …/course is the ruler), '
    + 'lateral = metres to the rider\'s right looking downhill (negative = left), above = metres over the '
    + 'terrain there (or y = an absolute height); { knot, along, lateral, above } names the station as metres '
    + 'past a knot. Every form lands as [x, y, z].',
  oneOf: [
    V3,
    {
      type: 'array', minItems: 3, maxItems: 3,
      items: [{ type: 'number' }, { type: ['number', 'null', 'string'] }, { type: 'number' }],
    },
    {
      type: 'object',
      properties: {
        station: { type: 'number' }, knot: { type: 'integer' }, along: { type: 'number' },
        lateral: { type: 'number' }, above: { type: 'number' }, y: { type: 'number' },
      },
    },
  ],
};

const SCHEMAS: Record<string, Record<string, unknown>> = {

  Login: {
    type: 'object',
    description: 'POST /api/auth/login on a server with accounts. Programs should prefer a personal access '
      + 'key sent as `Authorization: Bearer <key>` on every request instead of a session.',
    properties: {
      username: { type: 'string' },
      password: { type: 'string' },
    },
    required: ['username', 'password'],
  },

  CreateMap: {
    type: 'object',
    description: 'POST /api/projects. With no document, the server creates the default starter mountain — a '
      + 'complete, exportable terrain the editor also starts from — and the response carries the created '
      + 'project plus its full document, including every vertex/quad id needed for register addressing.',
    properties: {
      name: {
        type: 'string',
        description: 'Optional map name, applied at creation through the same free-name rule as a rename: '
          + 'sanitised to the SSX filename alphabet (spaces drop out, so "NOEL RIDGE" lands as NOELRIDGE), '
          + 'suffixed _2 and up when taken. The response carries the name that actually landed. Omitted, '
          + 'the map arrives as MOUNTAIN01_N and g/name renames it later.',
      },
      document: {
        description: 'Optional complete mountain document (see /api/schemas/MountainDocument). Omit it to '
          + 'start from the default mountain, which is the recommended path for an agent: edit the result '
          + 'through register assignments rather than composing a document from nothing.',
      },
    },
  },

  SaveDocument: {
    type: 'object',
    description: 'PUT /api/projects/{id}/document — replace the whole mountain optimistically. This is the '
      + 'only write that can change TOPOLOGY (which vertices and quads exist); everything else should go '
      + 'through POST …/registers, which cannot conflict. A 409 answer means the map moved on: it carries '
      + 'the current revision and document to rebase onto.',
    properties: {
      baseRevision: {
        type: 'integer',
        description: 'The revision this edit was made against — from the last GET or successful write.',
      },
      document: { description: 'The complete mountain document (see /api/schemas/MountainDocument).' },
    },
    required: ['baseRevision', 'document'],
  },

  AssignRegisters: {
    type: 'object',
    description: 'POST /api/projects/{id}/registers — the ordinary way to edit a map (docs/039). Each change '
      + 'assigns one register an absolute value; assignments are last-writer-wins and cannot conflict, so no '
      + 'baseRevision is needed. Register keys (see /api/schemas/RegisterKey): "v/<vertexId>" a vertex '
      + 'position [x,y,z] · "q/<quadId>/paint" a face\'s SurfaceType int · "q/<quadId>/tex" a face\'s tile '
      + 'ref "LEVEL/NNNN.png" · "o/prop/<id>" a whole placed prop · "o/light/<id>", "o/rail/<id>", '
      + '"o/gem/<id>", "o/model/<id>", "o/screen/<id>", "o/label/<id>", "o/volume/<id>" likewise · '
      + '"course" the run · "g/<field>" a document global such as g/name, g/sun, g/skybox, g/laps. '
      + 'Inserting an object: pick an unused id in that family\'s form (e.g. "prop:a001") and assign the '
      + 'whole object to o/<family>/<id>; the object\'s own `id` field must match the key (the server fills '
      + 'it in when absent). Omitting `value` (or `remove: true`) deletes what the key names. `rules` is the '
      + 'same write said as an intent: each rule names faces by label and sets their channels, and the '
      + 'server expands it into exactly these assignments before landing them. A change may itself carry '
      + 'intents the server expands the same way: a placement `pos` in the run\'s own frame or with Y on the '
      + 'ground (see PlacedProp.pos), a prop `yaw` of "course+90", `repeat` to make a row of one change, '
      + '`from` to copy another register and merge over it, and `shape` on an o/model to generate its '
      + 'geometry. The response counts them in `intents: {placed, repeated, copied, shaped, unseated}`.',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The register key. With `repeat`, it carries "{i}" where each clone\'s index goes.',
            },
            value: { description: 'The absolute value to assign. Absent = delete (unless `from` supplies it).' },
            remove: { type: 'boolean', description: 'Explicit delete, for clarity.' },
            from: {
              type: 'string',
              description: 'A register key this map holds whose value is copied, with `value` merged over it '
                + '(the copy\'s `id` gives way to this key). For a NEW key only: copying a register onto '
                + 'itself would be the per-field patch a register does not offer — read, change, assign whole. '
                + 'Read from the map as it stands when the request arrives, so a register created earlier in '
                + 'the same batch is not yet there to copy from.',
            },
            repeat: {
              type: 'object',
              description: 'Make this change a row. `count` clones, or one `every` so many metres along the '
                + 'run from the value\'s own { station } position `until` a station (which sets the station '
                + 'step). `step` is the per-clone increment: station / lateral / above for a run-relative '
                + 'position, x / y / z for an [x, y, z] one, yaw for either. "{i}" in the key and in `name` '
                + 'takes the index, from `start` (default 0). With `remove: true`, deletes the row again.',
              properties: {
                count: { type: 'integer', minimum: 1, maximum: 1000 },
                every: { type: 'number', description: 'Spacing in metres along the run.' },
                until: { type: 'number', description: 'The last station a clone may reach.' },
                start: { type: 'integer', minimum: 0 },
                step: {
                  type: 'object',
                  properties: {
                    station: { type: 'number' }, lateral: { type: 'number' }, above: { type: 'number' },
                    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, yaw: { type: 'number' },
                  },
                },
              },
            },
          },
          required: ['key'],
        },
      },
      rules: {
        type: 'array', maxItems: 1000,
        description: 'Selector writes: "paint/texture every quad in this section" as one rule instead of '
          + 'thousands of keys. Each rule is expanded server-side into ordinary q/<quadId>/<field> '
          + 'assignments, so nothing about last-writer-wins changes. Rules are applied in order and `changes` '
          + 'after all of them, so an explicit key always wins over a rule that touched it. The response '
          + 'gains `rules: [{matched, keys}]` — how many faces each named and how many keys it produced.',
        items: {
          type: 'object',
          properties: {
            where: {
              type: 'object',
              description: 'Which faces. A quad matches when it carries ALL the labels named, which is what '
                + 'makes an intersection ("the trail quads inside this one section") expressible. Labels are '
                + 'named by NAME or by id; a label this map has not got is refused by name rather than '
                + 'silently matching nothing.',
              properties: {
                labels: { type: 'array', items: { type: 'string' } },
                label: { type: 'string', description: 'Sugar for a single-label `labels`.' },
              },
            },
            set: {
              type: 'object',
              description: 'Quad channels ONLY. A prop is a whole-object register and there is no per-field '
                + 'patch below a register, so no rule can reach one: assign it whole as o/prop/<id>, or move '
                + 'a whole selection with POST …/seat. `null` clears a channel.',
              properties: {
                paint: { type: ['integer', 'null'], description: 'SurfaceType int; null resets.' },
                tex: { type: ['string', 'null'], description: 'Tile ref "LEVEL/NNNN.png"; null clears.' },
                orient: { description: '{ rot: 0-3, mirror: boolean }; null clears.' },
                lock: { type: ['boolean', 'null'], description: 'true locks; false/null unlocks.' },
                twist: { description: 'The face\'s four corner offsets; null clears.' },
                addLabel: { type: 'string', description: 'One label (name or id) added to each matched face.' },
                removeLabel: { type: 'string', description: 'One label removed from each matched face.' },
              },
            },
          },
          required: ['where', 'set'],
        },
      },
    },
  },

  SeatPlacements: {
    type: 'object',
    description: 'POST /api/projects/{id}/seat — put placements on the ground. Selects props carrying every '
      + 'label in `where` and/or the placements named in `ids` (the union), samples the top surface under '
      + 'each with the same sampler POST …/ground answers from, and sets its Y to height + `offset`. A rail '
      + 'is seated NODE BY NODE, so it follows the ground along its whole length rather than pivoting about '
      + 'its first point. This is a geometric operation, not a field patch: each placement\'s whole register '
      + 'is read, moved and assigned back through the ordinary last-writer-wins path. The answer is '
      + '{ revision, seated, skipped, unchanged } — `seated` placements that moved, `unchanged` ones already '
      + 'sitting there, `skipped` POINTS with no surface under them (a prop is one point, a rail one per '
      + 'node), which are left exactly where they are rather than dropped to zero.',
    properties: {
      where: {
        type: 'object',
        description: 'Props carrying ALL of these labels, by name or by id (GET …/labels lists them). A '
          + 'label this map has not got is refused by name.',
        properties: {
          labels: { type: 'array', items: { type: 'string' } },
          label: { type: 'string', description: 'Sugar for a single-label `labels`.' },
        },
      },
      ids: {
        type: 'array',
        description: 'Placements by id — "prop:a001", "rail:0000", "gem:0003", "light:0002" — or the whole '
          + 'register key ("o/prop/prop:a001"). This is how a rail, gem or light joins the selection: labels '
          + 'live on props. A screen and a model are not seatable (an attached screen\'s pos is in its '
          + 'prop\'s frame; a model is geometry rather than a placement).',
        items: { type: 'string' },
      },
      offset: {
        type: 'number',
        description: 'Metres above the surface; 0 sits it on the ground. A rail\'s own `height` standoff is '
          + 'what this normally carries.',
      },
    },
  },

  GroundQuery: {
    type: 'object',
    description: 'POST /api/projects/{id}/ground — where the terrain surface is, on the CURRENT document '
      + '(a live editing room included). The answer is { revision, heights } with heights[i] the '
      + 'top-surface Y in metres under points[i], or null where the mountain has no surface. Seat placed '
      + 'props, lights and buildings with it instead of re-deriving terrain math from the vertex buffer; '
      + 'query again after moving vertices, since sculpting changes the answer.',
    properties: {
      points: {
        type: 'array', maxItems: 4096,
        description: '[x, z] pairs in editor metres (Y is up); answered in order.',
        items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      },
    },
    required: ['points'],
  },

  ValidateDocument: {
    type: 'object',
    description: 'POST /api/projects/validate — read a document exactly as creating a map would read it, '
      + 'and write nothing. The answer is { ok, counts, problems }: `counts` names the vertices, quads, '
      + 'course knots and placed objects the server sees (null when the document could not be read at all), '
      + 'and `problems` is a list of { path, message } — a document that fails migration, a quad naming a '
      + 'corner the vertex buffer does not have, or an effects graph whose cross-table references do not '
      + 'resolve. Compose by hand only for topology; everything else is cheaper through registers.',
    properties: {
      document: { description: 'The complete mountain document (see /api/schemas/MountainDocument).' },
    },
    required: ['document'],
  },

  Preflight: {
    type: 'object',
    description: 'POST /api/preflight?project=<id> — what an export of a document would ship (docs/011): its '
      + 'painted tiles by page, its cells, the imported/authored models it places and the sky it carries. '
      + 'The answer is a Preflight report (core/export/preflight.ts) — `tiles`, `cells`, `importedModels`, '
      + '`sky` and the warnings each carries; an unresolvable prop page is what it exists to name. Scope it '
      + 'with ?project=<id>, because the map\'s own tile and model libraries are resolved inside it and an '
      + 'API caller has no browser tab to inherit one from.',
    properties: {
      doc: { description: 'The complete mountain document (see /api/schemas/MountainDocument).' },
    },
    required: ['doc'],
  },

  LabelIndex: {
    type: 'object',
    description: 'What GET /api/projects/{id}/labels answers: { projectId, revision, labels: [{ id, name, '
      + 'color, quadCount, propCount }] } — every semantic edit group in the map and how much it holds, off '
      + 'the CURRENT document (a live editing room included). GET …/labels/{labelId} adds `quadIds` and '
      + '`propIds`, which are the ids the q/<quadId>/… and o/prop/<id> registers name — so "repaint the '
      + 'village" is one read and one batch. Labels themselves are authored as o/label/<id> registers '
      + '(see /api/schemas/LabelDefinition); membership lives on the labelled thing.',
    properties: {
      projectId: { type: 'string' },
      revision: { type: 'integer' },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            color: { type: 'string' },
            quadCount: { type: 'integer' },
            propCount: { type: 'integer' },
          },
          required: ['id', 'name', 'quadCount', 'propCount'],
        },
      },
    },
  },

  RegisterKey: {
    type: 'string',
    description: 'How a register names one independently editable piece of a mountain (docs/039). '
      + 'Vertex position: "v/<vertexId>" holds [x,y,z] — vertex ids are in the document\'s vertexIds array. '
      + 'Crease: "h/<fromId>><toId>" holds a tangent-offset V3 for one directed edge. '
      + 'Face attributes: "q/<quadId>/<field>" where field is paint (SurfaceType int), tex (tile ref '
      + '"LEVEL/NNNN.png"), orient ({rot 0-3, mirror}), lock (true), twist (four V3s), labels (label-id '
      + 'array). '
      + 'Objects: "o/<family>/<objectId>" holds the whole object; families are prop, light, rail, gem, '
      + 'model, volume, screen, label, effect, effect-node. Effects rows are addressed as '
      + '"o/effect/<table>/<rowId>" and nodes as "o/effect-node/<table>/<rowId>/<nodeId>". '
      + 'The run: "course" holds the whole knot list. '
      + 'Globals: "g/<field>" — g/name, g/sun, g/glare, g/skybox, g/baseSurface, g/raceMusic, g/laps, '
      + 'g/showoffSeconds, g/aiSeed, g/boardSound, g/environmentBed and any other top-level document field '
      + 'that is not topology. '
      + 'TOPOLOGY (which vertices/quads exist) is deliberately not addressable — change it with '
      + 'PUT …/document.',
    pattern: '^(course|v/.+|h/.+>.+|q/.+/(paint|tex|orient|lock|twist|labels)|o/(prop|light|rail|gem|model|volume|screen|label|effect|effect-node)/.+|g/[^/]+)$',
  },

  MountainDocument: {
    type: 'object',
    description: 'The complete authored mountain (core/doc/types.ts, version 5): a bicubic-Bézier control '
      + 'net stored as a general quad mesh, plus everything placed on it. The surface is `vertices` (xyz '
      + 'flat, metres, Y-up) with stable `vertexIds`, and `quads` (four vertex INDICES each) with stable '
      + '`quadIds`; per-quad channels (quadPaint, quadTex, …) key by quad INDEX in memory. Prefer editing '
      + 'through registers; supply a whole document only to create from a template or to change topology.',
    properties: {
      kind: { const: 'mountain' },
      version: { const: 5 },
      name: { type: 'string' },
      spacing: { type: 'number', description: 'Nominal corner pitch of the net, metres.' },
      vertices: { type: 'array', items: { type: 'number' }, description: 'xyz flat; vertex i at [i*3..i*3+2].' },
      vertexIds: { type: 'array', items: { type: 'string' } },
      quads: {
        type: 'array',
        items: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
        description: 'Corner vertex indices [A@(0,0), B@(0,1), C@(1,0), D@(1,1)] — the Bézier winding.',
      },
      quadIds: { type: 'array', items: { type: 'string' } },
      nextId: { type: 'integer', description: 'Counter for the next minted vertex/quad id.' },
      course: { description: 'The one run — see /api/schemas/CoursePath.' },
      baseSurface: { type: 'integer', description: 'SurfaceType for unpainted faces (1 = snow).' },
      props: { type: 'array', description: 'Placed props — see /api/schemas/PlacedProp.' },
      lights: { type: 'array', description: 'Free-standing lights — see /api/schemas/AuthoredLight.' },
      rails: { type: 'array', description: 'Grind rails / motion paths — see /api/schemas/Rail.' },
      gems: { type: 'array', description: 'Pickups — see /api/schemas/Gem.' },
      sun: { description: 'The directional sun — see /api/schemas/SunLight.' },
      skybox: { description: 'The backdrop — see /api/schemas/SkyboxDoc.' },
      effects: { description: 'Portable SSF effect graph — see /api/schemas/EffectsDocument.' },
      laps: { type: 'integer', minimum: 1 },
      showoffSeconds: { type: 'number' },
    },
    required: ['kind', 'version', 'name', 'spacing', 'vertices', 'vertexIds', 'quads', 'quadIds', 'nextId',
      'course', 'baseSurface'],
    additionalProperties: true,
  },

  CoursePath: {
    type: 'object',
    description: 'The run: a LINE through the mountain the race follows — it does not itself shape terrain. '
      + 'Knot 0 is where the start gate straddles; the last knot (or `finish`) is where the race is won. '
      + 'Assign to the "course" register.',
    properties: {
      knots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pos: V3,
            width: { type: 'number', description: 'Run floor width here, metres; at knot 0 the gate span.' },
            wall: { type: 'number', description: 'Quarter-pipe wall height at each floor edge, metres.' },
            bank: { type: 'number', description: 'Roll of the cross-section, degrees; + raises rider\'s right.' },
            shoulder: { type: 'number', description: 'Flat shoulder beyond the wall tops, metres.' },
            checkpointBonus: { type: 'number', description: 'Seconds this station adds to a showoff clock.' },
          },
          required: ['pos', 'width', 'wall', 'bank', 'shoulder'],
        },
      },
      blend: { type: 'number', description: 'Metres the shaping fades back into surrounding terrain.' },
      surface: { type: 'integer', description: 'SurfaceType painted onto the run floor when shaped.' },
      start: { type: 'object', properties: { pos: V3 }, description: 'Staging point when not the head knot.' },
      finish: { type: 'object', properties: { pos: V3 }, description: 'Finish when not the tail knot.' },
    },
    required: ['knots', 'blend', 'surface'],
  },

  PlacedProp: {
    type: 'object',
    description: 'A prop borrowed from an extracted level (or an imported/authored model) placed on the '
      + 'mountain. `level` + `model` name the source geometry: a reference level name with a ModelID from '
      + 'that level\'s prop payload (GET /api/props?level=<LEVEL>), the pseudo-level "@import" with an '
      + 'imported prop\'s id (POST /api/custom-prop-import), or the pseudo-level "@models" with an authored '
      + 'model\'s number (o/model/model:0007 places as model 7). Assign whole to o/prop/<id>.',
    properties: {
      id: { type: 'string', description: 'Stable id, matching the register key — e.g. "prop:a001".' },
      level: { type: 'string' },
      model: { type: 'integer' },
      name: { type: 'string', description: 'Model name, for the outliner.' },
      pos: PLACED_POS,
      yaw: {
        type: ['number', 'string'],
        description: 'Degrees about vertical — or "course" (facing downhill along the run at this placement\'s '
          + 'station), "course+90" (facing the rider\'s left), "course-90" (the rider\'s right), "course+180" '
          + '(uphill), resolved to degrees before landing.',
      },
      pitch: { type: 'number' },
      roll: { type: 'number' },
      scale: { type: 'number', description: 'Uniform multiplier; 1 = source size.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Semantic label ids.' },
      solid: { type: 'boolean' },
      fullBright: { type: 'boolean', description: 'Self-lit: ships at full texture brightness, unshaded.' },
      surface: { type: 'integer', description: 'Rideable SurfaceType when solid; absent = obstacle.' },
      collisionSound: { type: 'integer', description: 'Native collision-sound event id.' },
      collisionSoundFile: { type: 'string', description: 'Uploaded WAV name; wins over collisionSound.' },
      ambientSound: { type: 'integer' },
      ambientSoundFile: { type: 'string' },
      ambientRadius: { type: 'number' },
      group: { type: 'string', description: 'Group-def id when this placement is a mined group.' },
      effectTrigger: {
        type: 'object', properties: { size: V3 },
        description: 'Makes this an invisible trigger volume for effects: use level "@effects", model 0, '
          + 'pos at the box centre, and attach a collision effect to the placement\'s id.',
      },
      modePresence: { const: 'showoff', description: 'Present only in Showoff when set.' },
    },
    required: ['level', 'model', 'name', 'pos', 'yaw', 'scale'],
    additionalProperties: true,
  },

  AuthoredLight: {
    type: 'object',
    description: 'A free-standing coloured point or spot light. Assign whole to o/light/<id>.',
    properties: {
      id: { type: 'string', description: 'e.g. "light:0000".' },
      kind: { enum: ['point', 'spot'] },
      pos: PLACED_POS,
      dir: { ...V3, description: 'Spot aim (unit vector); absent = straight down.' },
      color: { type: 'string', description: 'Hex "#rrggbb".' },
      intensity: { type: 'number', description: '1 = a plain light; higher is HDR-bright.' },
      reach: { type: 'number', description: 'Metres — sizes falloff and the exported influence box.' },
      cone: { type: 'number', description: 'Spot half-angle, degrees; absent = 35.' },
      name: { type: 'string' },
      glint: { type: 'integer', description: 'Sparkle sprite resolution 16/32/64; absent/0 = none.' },
    },
    required: ['kind', 'pos', 'color', 'intensity', 'reach'],
    additionalProperties: true,
  },

  Rail: {
    type: 'object',
    description: 'A grind rail (or invisible motion path): a chain of node points floated above the terrain, '
      + 'splined into a curve. Node Y carries the standoff — lay nodes `height` above the ground they '
      + 'follow. Assign whole to o/rail/<id>.',
    properties: {
      id: { type: 'string', description: 'e.g. "rail:0000".' },
      kind: { enum: ['grind', 'motion'], description: 'Absent = grind.' },
      nodes: { type: 'array', items: PLACED_POS, minItems: 2, description: 'Resolved node by node.' },
      height: { type: 'number', description: 'Standoff metres the rail was laid at above the terrain.' },
      style: { type: 'integer', description: '13 metal (default), 12 wood, 5 ice.' },
      bare: { type: 'boolean', description: 'Ship the spline without a visible tube.' },
      solid: { type: 'boolean', description: 'The baked tube collides.' },
      supports: { type: 'boolean', description: 'Bake a post under each node.' },
      startsOff: { type: 'boolean', description: 'Grindable only after a Rail-on effect.' },
      name: { type: 'string' },
    },
    required: ['nodes', 'height'],
    additionalProperties: true,
  },

  Gem: {
    type: 'object',
    description: 'A collectible trick-score pickup floated above the course. Assign whole to o/gem/<id>.',
    properties: {
      id: { type: 'string', description: 'e.g. "gem:0000".' },
      pos: PLACED_POS,
      value: { type: 'integer', description: 'Score-multiplier tier; absent = 1.' },
    },
    required: ['pos'],
    additionalProperties: true,
  },

  Screen: {
    type: 'object',
    description: 'A video screen rectangle (docs/051). Attached to a prop (pos in the prop\'s frame) or '
      + 'free-standing (pos in world space). Assign whole to o/screen/<id>.',
    properties: {
      id: { type: 'string', description: 'e.g. "screen:0000".' },
      name: { type: 'string' },
      prop: { type: 'string', description: 'PlacedProp id this screen is fitted to; absent = free-standing.' },
      pos: V3,
      yaw: { type: 'number' },
      pitch: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    },
    required: ['pos', 'yaw', 'width', 'height'],
    additionalProperties: true,
  },

  LabelDefinition: {
    type: 'object',
    description: 'A semantic edit group. Membership lives on the labelled things (a prop\'s `labels`, a '
      + 'face\'s q/<id>/labels register) as this label\'s id. Assign whole to o/label/<id>.',
    properties: {
      id: { type: 'string', description: 'e.g. "label:0000".' },
      name: { type: 'string' },
      color: { type: 'string', description: 'Optional UI swatch, hex.' },
    },
    required: ['id', 'name'],
    additionalProperties: true,
  },

  SunLight: {
    type: 'object',
    description: 'The authored directional sun, previewed live and baked into lightmaps on export. Assign '
      + 'to g/sun.',
    properties: {
      on: { type: 'boolean' },
      el: { type: 'number', description: 'Elevation above horizon, degrees.' },
      az: { type: 'number', description: 'Azimuth, degrees.' },
      ambient: { type: 'number', description: 'Sky-fill floor, ~0..1.' },
      sun: { type: 'number', description: 'Direct-sun strength; 1.0 bakes lit snow to full white.' },
      shadow: { type: 'number' },
      ao: { type: 'number' },
      sunTint: { type: 'string', description: 'Hex "#rrggbb".' },
      skyTint: { type: 'string' },
    },
    required: ['on', 'el', 'az', 'ambient', 'sun', 'shadow', 'ao', 'sunTint', 'skyTint'],
    additionalProperties: true,
  },

  SkyboxDoc: {
    type: 'object',
    description: 'The backdrop behind the mountain: a shipped level\'s sky taken whole '
      + '({source:{kind:"level", level:"GARI"}}) or an uploaded panorama by name '
      + '({source:{kind:"custom", name:"dusk.png"}} after POST /api/skyupload). Assign to g/skybox.',
    properties: {
      source: {
        oneOf: [
          {
            type: 'object',
            properties: { kind: { const: 'level' }, level: { type: 'string' } },
            required: ['kind', 'level'],
          },
          {
            type: 'object',
            properties: { kind: { const: 'custom' }, name: { type: 'string' } },
            required: ['kind', 'name'],
          },
        ],
      },
      on: { type: 'boolean' },
      topColor: { type: 'string', description: 'Flat colour above the ring, hex; absent = derived.' },
      tier: { enum: ['standard', 'high'], description: 'Custom-sky texture budget.' },
      ring: { type: 'string', description: 'Level whose ring geometry a custom sky is cut against.' },
    },
    required: ['source', 'on'],
    additionalProperties: true,
  },

  AuthoredModel: {
    type: 'object',
    description: 'A polygon model authored with the mesh tools: a small world-space quad mesh evaluated '
      + 'flat — the surface IS the polygons. Assign whole to o/model/<id> with an id of the form '
      + '"model:NNNN"; place it with a prop whose level is "@models" and whose model is that number. '
      + 'Vertices are world metres at the spot it was built; `anchor` is the placement reference point, so '
      + 'an instance at pos P renders vertex v at pose(v − anchor). Instead of vertices and quads, a register '
      + 'write may send `shape` and the server generates them: base at y = 0, footprint centred on the '
      + 'origin, anchor [0, 0, 0], so a placement\'s pos is where it stands and its yaw turns it. A quad wears '
      + 'the whole tile, so `segments` is how many times the tile repeats along an edge. The document keeps '
      + 'the geometry, not the recipe.',
    properties: {
      id: { type: 'string', description: 'e.g. "model:0000".' },
      name: { type: 'string' },
      anchor: { ...V3, description: 'Placement reference point.' },
      vertices: { type: 'array', items: { type: 'number' }, description: 'World metres, xyz flat.' },
      quads: { type: 'array', items: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 } },
      shape: {
        type: 'object',
        description: 'Generated geometry (write only). box: { size: [w, h, d], segments: [nx, ny, nz], top '
          + '(default true), bottom (default false) }. house: four walls to size[1] with a gable triangle at '
          + 'each X end rising to `ridge` — { size: [w, wall, d], ridge, segments: [long, end] }; the ridge '
          + 'runs along the model\'s X, the eaves are its ±Z faces. roof: two planes over a { size: [w, d] } '
          + 'footprint from `eave` height up to `ridge`, `overhang` (default 0.6) past the walls, `segments` '
          + 'along the ridge — place it on the same pos and yaw as its house. panel: a flat rectangle standing '
          + 'on its bottom edge facing +Z — { size: [w, h], segments: [nx, ny], double } — a sign, a window '
          + 'card, a light strip.',
        properties: {
          kind: { enum: ['box', 'house', 'roof', 'panel'] },
          size: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 },
          segments: { description: 'Tile repeats per edge, 1–64 each; one integer for a roof.' },
          ridge: { type: 'number' }, eave: { type: 'number' }, overhang: { type: 'number' },
          top: { type: 'boolean' }, bottom: { type: 'boolean' }, double: { type: 'boolean' },
        },
        required: ['kind', 'size'],
      },
      texture: { type: 'string', description: 'Tile ref "LEVEL/NNNN.png"; absent = untextured clay.' },
      solid: { type: 'boolean' },
      blend: { type: 'boolean', description: 'Render through the alpha pass.' },
    },
    required: ['name'],
    additionalProperties: true,
  },

  EffectsDocument: {
    type: 'object',
    description: 'The portable SSF effect graph (core/effects/document.ts): eight row tables — slots, '
      + 'graphs, functions, objectProperties, instances, physics, collisionModels, splines — each row '
      + 'carrying its own id. Through registers, rows are addressed one at a time as '
      + 'o/effect/<table>/<rowId>, the nodes a graph or function owns as '
      + 'o/effect-node/<table>/<rowId>/<nodeId>, and the document\'s own fields as o/effect/document. '
      + 'Study a shipped graph first: GET /api/effects?level=<LEVEL> returns a reference level\'s whole '
      + 'effects document in this same shape.',
    properties: {
      slots: { type: 'array' },
      graphs: { type: 'array' },
      functions: { type: 'array' },
      objectProperties: { type: 'array' },
      instances: { type: 'array' },
      physics: { type: 'array' },
      collisionModels: { type: 'array' },
      splines: { type: 'array' },
    },
    additionalProperties: true,
  },

  ImportedPropRecord: {
    type: 'object',
    description: 'POST /api/custom-prop-import?project=<id>&name=<stem> — a decoded model entering the '
      + 'map\'s own prop library (core/props/imported.ts). The caller does the GLB parsing: `subs` carry '
      + 'base64 vertex positions (float32 xyz, raw native centimetres), UVs (float32) and triangle indices '
      + '(uint16/uint32); `materials` map local material ids to texture refs in the "Custom/<name>.png" '
      + 'form (null = untextured clay). Omit `id` — the server assigns the model number and answers with '
      + 'it; place the result with a prop at level "@import".',
    properties: {
      name: { type: 'string' },
      tris: { type: 'integer' },
      subs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            mat: { type: 'integer' },
            pos: { type: 'string', description: 'base64 float32 xyz triples, native raw centimetres.' },
            uv: { type: 'string', description: 'base64 float32 uv pairs.' },
            idx: { type: 'string', description: 'base64 triangle indices.' },
          },
          required: ['mat', 'pos', 'uv', 'idx'],
        },
      },
      materials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tex: { type: ['string', 'null'], description: '"Custom/<name>.png" or null.' },
            blend: { type: 'boolean' },
          },
          required: ['id', 'tex'],
        },
      },
    },
    required: ['name', 'tris', 'subs', 'materials'],
    additionalProperties: true,
  },

  TakeCheckpoint: {
    type: 'object',
    description: 'POST /api/projects/{id}/checkpoints — set the map down as a named point in its history.',
    properties: {
      note: { type: 'string', description: 'Why this moment is worth keeping. Required for a named one.' },
      reason: { enum: ['named', 'bulk'], description: 'Default named.' },
    },
    required: ['note'],
  },

  RestoreCheckpoint: {
    type: 'object',
    description: 'POST /api/projects/{id}/checkpoints/{file}/restore — adopt a checkpoint as the next '
      + 'revision. Optimistic like a document save; 409 carries the current state to rebase onto.',
    properties: {
      baseRevision: { type: 'integer' },
    },
    required: ['baseRevision'],
  },

  SetMapPermissions: {
    type: 'object',
    description: 'PUT /api/projects/{id}/permissions — null opens editing to every editor-role member; an '
      + 'array restricts it to those user ids (the owner and moderators always may).',
    properties: {
      editorIds: {
        oneOf: [
          { type: 'null' },
          { type: 'array', items: { type: 'string' }, maxItems: 1000 },
        ],
      },
    },
    required: ['editorIds'],
  },
};

const INDEX_HINTS: Record<string, string> = {
  Login: 'Sign a browser session in (programs use a bearer key instead)',
  CreateMap: 'Create a mountain, from the default starter or a whole document',
  SaveDocument: 'Replace a whole document optimistically (the only topology write)',
  AssignRegisters: 'Edit a map register-by-register, or a whole labelled section by rule',
  SeatPlacements: 'Put a section of placements on the ground in one call',
  GroundQuery: 'Batch surface-height lookup — where placements seat',
  ValidateDocument: 'Read a hand-authored document without creating a map from it',
  Preflight: 'What an export of a document would ship',
  LabelIndex: 'Which quads and props each of a map\'s labels holds',
  RegisterKey: 'The register key grammar: what one key can name',
  MountainDocument: 'The complete authored mountain document',
  CoursePath: 'The run — assigned to the "course" register',
  PlacedProp: 'A placed prop — o/prop/<id>',
  AuthoredLight: 'A placed light — o/light/<id>',
  Rail: 'A grind rail or motion path — o/rail/<id>',
  Gem: 'A pickup — o/gem/<id>',
  Screen: 'A video screen — o/screen/<id>',
  LabelDefinition: 'A semantic edit group — o/label/<id>',
  SunLight: 'The sun — g/sun',
  SkyboxDoc: 'The backdrop — g/skybox',
  AuthoredModel: 'A hand-built polygon model — o/model/<id>',
  EffectsDocument: 'The SSF effect graph and its register addressing',
  ImportedPropRecord: 'A decoded GLB entering the map\'s prop library',
  TakeCheckpoint: 'Keep this moment in the map\'s history',
  RestoreCheckpoint: 'Adopt a checkpoint as the next revision',
  SetMapPermissions: 'Restrict who may edit one map',
};

export const schemaRoutes: Record<string, ApiHandler> = {
  '/api/schemas': (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+|\/+$/g, ''));
    if (!name) {
      const envelope: HateoasEnvelope = {
        _links: [link('self', '/api/schemas'), link('root', '/api')],
        _linkTemplates: [{ rel: 'item', hrefTemplate: '/api/schemas/{name}' }],
      };
      jsonResponse(res, 200, {
        schemas: Object.keys(SCHEMAS).map(held => ({
          name: held, href: `/api/schemas/${held}`, title: INDEX_HINTS[held],
        })),
        ...envelope,
      });
      return;
    }
    const schema = SCHEMAS[name];
    if (!schema) {
      jsonResponse(res, 404, {
        error: `No schema is named ${name}.`,
        _links: [link('collection', '/api/schemas', 'Every schema this server serves')],
      });
      return;
    }
    jsonResponse(res, 200, { $schema: 'https://json-schema.org/draft/2020-12/schema', title: name, ...schema });
  },
};
