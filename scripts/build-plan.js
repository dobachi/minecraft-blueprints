#!/usr/bin/env node
/**
 * Expand a blueprint written in relative coordinates into a concrete build plan
 * anchored at a given world position.
 *
 * A blueprint never contains absolute coordinates, so the same file builds the
 * same structure anywhere — in any world — by changing only --at.
 *
 * Usage:
 *   node scripts/build-plan.js <blueprint.yaml> --at <x> <y> <z> [--format text|json|commands]
 *
 * Formats:
 *   text      human-readable plan (default) — read this before building
 *   json      one entry per MCP tool call, ready to hand to the minecraft-bedrock tools
 *   commands  raw Bedrock commands, for /execute or manual paste
 *
 * The plan is only printed. Nothing touches the world until someone runs it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function die(msg) {
  console.error(`build-plan: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { file: null, at: null, format: "text" };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--at") {
      const nums = argv.slice(i + 1, i + 4).map(Number);
      if (nums.length !== 3 || nums.some(Number.isNaN)) {
        die("--at requires three numbers: --at <x> <y> <z>");
      }
      args.at = nums;
      i += 3;
    } else if (a === "--format") {
      args.format = argv[++i];
    } else if (a === "-h" || a === "--help") {
      console.log(
        fs
          .readFileSync(__filename, "utf8")
          .split("\n")
          .slice(1, 19)
          .map((l) => l.replace(/^ ?\*\/?/, "").replace(/^ /, ""))
          .join("\n")
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      die(`unknown option: ${a}`);
    } else if (!args.file) {
      args.file = a;
    } else {
      die(`unexpected argument: ${a}`);
    }
  }

  if (!args.file) die("no blueprint given. See --help.");
  if (!args.at) die("--at <x> <y> <z> is required (the anchor position).");
  if (!["text", "json", "commands"].includes(args.format)) {
    die(`unknown format: ${args.format}`);
  }
  return args;
}

// ------------------------------------------------------------- coordinates

const isTriple = (v) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n));

/** Relative offset -> absolute world position. */
const toWorld = (anchor, rel) => [
  anchor[0] + rel[0],
  anchor[1] + rel[1],
  anchor[2] + rel[2],
];

// ---------------------------------------------------------------- expansion

/**
 * Turn one blueprint step into one or more planned operations.
 * Each operation carries both the MCP tool call and the equivalent raw command,
 * so the caller can pick whichever channel it has available.
 */
function expandStep(step, anchor, index) {
  const label = step.name || `step ${index + 1}`;
  const ops = [];

  const requireTriple = (field) => {
    if (!isTriple(step[field])) {
      die(`${label}: "${field}" must be three integers, got ${JSON.stringify(step[field])}`);
    }
    return toWorld(anchor, step[field]);
  };

  switch (step.op) {
    case "fill": {
      const [x1, y1, z1] = requireTriple("from");
      const [x2, y2, z2] = requireTriple("to");
      const mode = step.mode || "replace";
      ops.push({
        label,
        tool: "blocks",
        args: {
          action: "fill_area",
          x: x1, y: y1, z: z1,
          x2, y2, z2,
          block_id: step.block,
          mode,
        },
        command: `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${bare(step.block)}${
          mode === "replace" ? "" : ` ${mode}`
        }`,
      });
      break;
    }

    case "cube": {
      const [x1, y1, z1] = requireTriple("from");
      const [x2, y2, z2] = requireTriple("to");
      ops.push({
        label,
        tool: "build_cube",
        args: {
          action: "build",
          x1, y1, z1, x2, y2, z2,
          material: step.block,
          hollow: Boolean(step.hollow),
        },
        // build_cube decomposes into several fills internally; the raw form of a
        // hollow cube is six faces, so no single equivalent command exists.
        command: step.hollow
          ? null
          : `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${bare(step.block)}`,
      });
      break;
    }

    case "setblock": {
      const positions = step.at;
      if (!Array.isArray(positions) || positions.length === 0) {
        die(`${label}: "at" must be a non-empty list of [x,y,z] triples`);
      }
      positions.forEach((rel, i) => {
        if (!isTriple(rel)) {
          die(`${label}: at[${i}] must be three integers, got ${JSON.stringify(rel)}`);
        }
        const [x, y, z] = toWorld(anchor, rel);
        ops.push({
          label: positions.length > 1 ? `${label} (${i + 1}/${positions.length})` : label,
          // Blocks needing state (doors and the like) must go through a raw command;
          // the set_block tool takes an id only.
          tool: step.raw ? "world" : "blocks",
          args: step.raw
            ? { action: "run_command", command: `setblock ${x} ${y} ${z} ${bare(step.block)}` }
            : { action: "set_block", x, y, z, block_id: step.block },
          command: `setblock ${x} ${y} ${z} ${bare(step.block)}`,
        });
      });
      break;
    }

    case "command": {
      // Escape hatch: a literal command with {x} {y} {z} placeholders resolved
      // against the anchor plus an optional offset.
      const rel = step.at && isTriple(step.at) ? step.at : [0, 0, 0];
      const [x, y, z] = toWorld(anchor, rel);
      const cmd = String(step.command)
        .replaceAll("{x}", x)
        .replaceAll("{y}", y)
        .replaceAll("{z}", z);
      ops.push({
        label,
        tool: "world",
        args: { action: "run_command", command: cmd },
        command: cmd,
      });
      break;
    }

    default:
      die(`${label}: unknown op "${step.op}" (expected fill, cube, setblock or command)`);
  }

  for (const op of ops) op.why = step.why;
  return ops;
}

/** Bedrock commands take bare block names — `minecraft:` is accepted but noisy. */
const bare = (id) => String(id).replace(/^minecraft:/, "");

// ------------------------------------------------------------- bounds check

function checkBounds(blueprint, ops, anchor) {
  if (!blueprint.bounds) return [];
  const { min, max } = blueprint.bounds;
  if (!isTriple(min) || !isTriple(max)) return [];

  const lo = toWorld(anchor, min);
  const hi = toWorld(anchor, max);
  const warnings = [];

  for (const op of ops) {
    const pts = [];
    const a = op.args;
    if (a.x !== undefined) pts.push([a.x, a.y, a.z]);
    if (a.x2 !== undefined) pts.push([a.x2, a.y2, a.z2]);
    if (a.x1 !== undefined) pts.push([a.x1, a.y1, a.z1]);

    for (const p of pts) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < lo[i] || p[i] > hi[i]) {
          warnings.push(
            `${op.label}: ${"xyz"[i]}=${p[i]} falls outside the declared bounds ` +
              `(${lo[i]}..${hi[i]}). Either the step or "bounds" is wrong.`
          );
        }
      }
    }
  }
  return [...new Set(warnings)];
}

// ------------------------------------------------------------------ output

function renderText(blueprint, ops, anchor, warnings) {
  const out = [];
  out.push(`${blueprint.name} v${blueprint.version ?? 1} — ${ops.length} operations`);
  if (blueprint.description) out.push(blueprint.description);
  out.push(`anchor: (${anchor.join(", ")})`);
  if (blueprint.anchor?.description) out.push(`  ${blueprint.anchor.description}`);
  out.push("");

  if (blueprint.preconditions?.length) {
    out.push("preconditions (not checked automatically):");
    for (const p of blueprint.preconditions) out.push(`  - ${p}`);
    out.push("");
  }

  ops.forEach((op, i) => {
    const a = op.args;
    let where;
    // x1 first: build_cube uses x1/x2 while fill_area uses x/x2, and testing x2
    // first would misread a cube as a fill and print undefined for its origin.
    if (a.x1 !== undefined) where = `(${a.x1},${a.y1},${a.z1}) -> (${a.x2},${a.y2},${a.z2})`;
    else if (a.x2 !== undefined) where = `(${a.x},${a.y},${a.z}) -> (${a.x2},${a.y2},${a.z2})`;
    else if (a.x !== undefined) where = `(${a.x},${a.y},${a.z})`;
    else where = a.command;

    const what = a.block_id || a.material || "";
    const extra = [
      a.mode && a.mode !== "replace" ? `mode=${a.mode}` : null,
      a.hollow ? "hollow" : null,
    ].filter(Boolean).join(" ");

    out.push(`${String(i + 1).padStart(2)}. ${op.label}`);
    out.push(`    ${op.tool}  ${where}  ${what} ${extra}`.trimEnd());
  });

  if (warnings.length) {
    out.push("");
    out.push("WARNINGS:");
    for (const w of warnings) out.push(`  ! ${w}`);
  }

  if (blueprint.todo?.length) {
    out.push("");
    out.push("known gaps in this blueprint:");
    for (const t of blueprint.todo) out.push(`  - ${String(t).trim()}`);
  }

  return out.join("\n");
}

// -------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));

const file = path.resolve(args.file);
if (!fs.existsSync(file)) die(`no such blueprint: ${file}`);

let blueprint;
try {
  blueprint = yaml.load(fs.readFileSync(file, "utf8"));
} catch (e) {
  die(`could not parse ${path.basename(file)}: ${e.message}`);
}

if (!blueprint || typeof blueprint !== "object") die("blueprint is empty");
if (!Array.isArray(blueprint.steps) || blueprint.steps.length === 0) {
  die("blueprint has no steps");
}

const ops = blueprint.steps.flatMap((s, i) => expandStep(s, args.at, i));
const warnings = checkBounds(blueprint, ops, args.at);

switch (args.format) {
  case "json":
    console.log(JSON.stringify({ blueprint: blueprint.name, anchor: args.at, ops }, null, 2));
    break;
  case "commands":
    for (const op of ops) {
      if (op.command) console.log(op.command);
      else console.log(`# ${op.label}: no single-command equivalent (hollow cube)`);
    }
    break;
  default:
    console.log(renderText(blueprint, ops, args.at, warnings));
}

// Warnings go to stderr too, so they survive a redirect of stdout.
if (warnings.length && args.format !== "text") {
  for (const w of warnings) console.error(`build-plan: WARNING ${w}`);
}
