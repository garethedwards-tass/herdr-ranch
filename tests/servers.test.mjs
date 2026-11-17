// The Servers mod's pure side: the probe's output, container health, meters and alerts.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbe, containerHealth, needsAttention, usage, containerAlerts, shortStatus, machineState, memShort } from "../herdr-ranch-servers/mods/herdr-ranch-servers/probe.js";

const out = ["os=Darwin", "load=2,5 1.0 0.5", "cpus=10", "mem=34359738368 17179869184", "disk=1000 400 600", "uptime=90000",
  "c=a1\tdb\trunning\tUp 2 hours (healthy)\tpostgres\tshop", "c=b2\tworker\trunning\tUp 5 minutes (unhealthy)\twrk\tshop",
  "c=c3\told\texited\tExited (0) 3 days ago\tx\t", "c=d4\tcrash\texited\tExited (137) 1 hour ago\ty\t"].join("\n");

test("parseProbe: meters, decimal commas and containers", () => {
  const p = parseProbe(out);
  assert.deepEqual(p.load, [2.5, 1, 0.5]);
  assert.deepEqual(usage(p), { cpu: 25, mem: 50, disk: 40 });
  assert.deepEqual(p.docker.containers.map((c) => [c.name, containerHealth(c), needsAttention(c)]),
    [["db", "ok", false], ["worker", "unhealthy", true], ["old", "stopped", false], ["crash", "down", true]]);
  assert.deepEqual(parseProbe("docker_err=permission denied while trying to connect").docker, { error: "no permission" });
});

test("containerAlerts: down and back, nothing on the first look", () => {
  const before = parseProbe("c=1\tweb\trunning\tUp 1 hour\tnginx\t"), after = parseProbe("c=1\tweb\trestarting\tRestarting (1)\tnginx\t");
  assert.deepEqual(containerAlerts(null, after), []);
  assert.deepEqual(containerAlerts(before, after), [{ name: "web", health: "restarting", down: true }]);
  assert.deepEqual(containerAlerts(after, before), [{ name: "web", health: "ok", down: false }]);
});

test("shortStatus: how long it's up, or what's wrong", () => {
  const c = (state, status) => ({ state, status });
  assert.deepEqual([c("running", "Up 2 hours (healthy)"), c("running", "Up About an hour"), c("running", "Up 5 minutes"), c("running", "Up Less than a second"),
    c("running", "Up 3 days"), c("running", "Up 2 minutes (unhealthy)"), c("restarting", "Restarting (1) 5 seconds ago"), c("exited", "Exited (137) 1 hour ago"), c("exited", "Exited (0) 2 days ago")].map(shortStatus),
    ["up 2h", "up 1h", "up 5m", "up <1m", "up 3d", "unhealthy", "restarting", "exit 137", "stopped"]);
});

test("machineState: the machine pill's tone and text", () => {
  assert.deepEqual(machineState(null), { tone: "dim", text: "…" });
  assert.deepEqual(machineState({ offline: true }), { tone: "bad", text: "offline" });
  assert.deepEqual(machineState({ data: parseProbe(out) }), { tone: "bad", text: "2 need you" });
  assert.deepEqual(machineState({ data: parseProbe("cpus=4\nload=1 1 1\nmem=100 60\ndisk=10 1 9\nc=1\tweb\trunning\tUp 1 hour\tnginx\t") }), { tone: "ok", text: "1/1 · 40%" });
  assert.deepEqual(machineState({ data: parseProbe("cpus=4\nload=1 1 1\nmem=100 20\ndisk=10 1 9\ndocker_err=not installed") }), { tone: "warn", text: "no docker · 80%" });
});

test("memory: docker stats on each container, its pill shows it", () => {
  const p = parseProbe("c=1\tcf\trunning\tUp 2 hours (healthy)\tcf\tshop\ns=cf\t2.853GiB / 3GiB\t95.11%\t1.70%");
  assert.deepEqual(p.docker.containers[0].usage, { mem: "2.853GiB / 3GiB", memPct: 95.11, cpuPct: 1.7 });
  assert.equal(shortStatus(p.docker.containers[0]), "2.9 GB · 95%");
  assert.deepEqual(["9.367MiB / 128MiB", "1023MiB / 2GiB", "12.4GiB / 16GiB", "800KiB / 1GiB"].map(memShort), ["9 MB", "1.0 GB", "12 GB", "1 MB"]);
});

import { stacksOf, groupByLane, laneState, hostOf } from "../herdr-ranch-servers/mods/herdr-ranch-servers/lanes.js";

const ct = (name, dir, service, labels = {}, state = "running") => ({ name, dir, service, state, labels: { lane: "", url: "", database: "", owner: "", branch: "", serves: "", ...labels } });

test("lanes: from the containers' lane labels, grouped by lane, then shared, then the rest", () => {
  const l2 = { lane: "2", url: "https://app-2.example.test/", database: "app2", owner: "PROJ-1", branch: "PROJ-1", serves: "web=/w/web-PROJ-1;api=/w/api" };
  const cs = [ct("p_app", "/stack", "app", { lane: "1", url: "https://app.example.test/" }), ct("p_api", "/stack", "api", { lane: "1" }, "exited"),
    ct("p_lane2_app", "/stack", "app2", l2), ct("p_proxy", "/stack", "proxy"), ct("other", "/elsewhere", "web")];
  const st = stacksOf(cs);
  assert.deepEqual(st.map((s) => s.dir), ["/stack"]);
  assert.deepEqual(st[0].lanes.map((l) => [l.n, l.state, laneState(l).text, laneState(l).tone, hostOf(l.url), l.served]), [
    [1, "partly running", "free", "ok", "app.example.test", []],
    [2, "running", "PROJ-1", "held", "app-2.example.test", [{ repo: "web", path: "/w/web-PROJ-1" }, { repo: "api", path: "/w/api" }]],
  ]);
  assert.deepEqual(groupByLane(cs, st).map((g) => [g.kind, g.lane?.n ?? null, g.containers.map((c) => c.name)]),
    [["lane", 1, ["p_app", "p_api"]], ["lane", 2, ["p_lane2_app"]], ["shared", null, ["p_proxy"]], ["other", null, ["other"]]]);
});

test("lanes: no lane labels, no lanes", () => {
  assert.deepEqual(stacksOf([ct("a", "/stack", "app"), ct("b", "/stack", "db")]), []);
});

test("lanes: who holds a lane comes from its newest container (labels change only on recreate)", () => {
  const old = ct("p_api", "/stack", "api", { lane: "2", owner: "PROJ-1", branch: "PROJ-1" }), fresh = ct("p_app", "/stack", "app", { lane: "2", owner: "", branch: "" });
  old.created = "2026-11-17 01:00:00 +1000 AEST"; fresh.created = "2026-11-17 03:00:00 +1000 AEST";
  assert.equal(laneState(stacksOf([old, fresh])[0].lanes[0]).text, "free");
  assert.equal(laneState(stacksOf([{ ...old, created: "2026-11-17 04:00:00 +1000 AEST" }, fresh])[0].lanes[0]).text, "PROJ-1");
});
