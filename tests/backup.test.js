/**
 * Backup import/export.
 *
 * Import can destroy work, so the module separates "what would this do" (plan)
 * from "do it" (the controller). These tests pin the plan: what is rejected, what
 * is dropped, and the fact that a plan never coerces a bad file into a valid one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFilename,
  describeImportPlan,
  exportSettings,
  planImport
} from "../src/backup.js";

const SETTINGS = {
  mode: "proxy",
  scheme: "socks5",
  host: "127.0.0.1",
  port: "7890",
  includeSubdomains: true,
  localBypass: true,
  whitelist: [{ host: "github.com", includeSubdomains: true }],
  blacklist: [{ host: "ads.example.com", includeSubdomains: false }]
};

test("an export round-trips through import without losing anything", () => {
  const file = exportSettings(SETTINGS, { exportedAt: "2026-11-23T00:00:00.000Z" });
  assert.equal(file.format, BACKUP_FORMAT);
  assert.equal(file.version, BACKUP_VERSION);

  const { ok, plan } = planImport(JSON.stringify(file));
  assert.equal(ok, true);
  assert.deepEqual(plan.settings.whitelist, SETTINGS.whitelist);
  assert.deepEqual(plan.settings.blacklist, SETTINGS.blacklist);
  assert.equal(plan.settings.host, "127.0.0.1");
  assert.equal(plan.settings.port, "7890");
});

test("the export carries only known fields, not whatever else is in storage", () => {
  const file = exportSettings({ ...SETTINGS, internalFlag: true, whitelist: [{ host: "a.example", includeSubdomains: true, extra: 1 }] });
  assert.equal("internalFlag" in file.settings, false);
  assert.deepEqual(file.settings.whitelist, [{ host: "a.example", includeSubdomains: true }]);
});

test("files that are not ours are rejected with an explanation", () => {
  assert.equal(planImport("not json").ok, false);
  assert.equal(planImport("[]").ok, false);
  assert.equal(planImport("{}").ok, false);
  assert.match(planImport("{}").error, /不是 Alaxee Proxy 的备份文件/);
});

test("a file from a newer version is refused instead of silently misread", () => {
  const file = exportSettings(SETTINGS);
  file.version = BACKUP_VERSION + 1;
  const result = planImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /更新/);
});

test("invalid and duplicate rules are counted, not silently swallowed", () => {
  const file = exportSettings(SETTINGS);
  file.settings.whitelist = [
    { host: "ok.example", includeSubdomains: true },
    { host: "ok.example", includeSubdomains: true },
    { host: "", includeSubdomains: true }
  ];
  const { ok, plan } = planImport(JSON.stringify(file));
  assert.equal(ok, true);
  assert.equal(plan.counts.whitelist, 1);
  assert.equal(plan.dropped.whitelist, 2);
  assert.match(describeImportPlan(plan), /2 条无效或重复/);
});

test("unknown modes and schemes fall back instead of breaking routing", () => {
  const file = exportSettings(SETTINGS);
  file.settings.mode = "system";
  file.settings.scheme = "quic";
  const { plan } = planImport(JSON.stringify(file));
  assert.equal(plan.settings.mode, "proxy");
  assert.equal(plan.settings.scheme, "socks5");
});

test("an import always replaces both lists, and says so", () => {
  const { plan } = planImport(JSON.stringify(exportSettings(SETTINGS)));
  assert.equal(plan.replace, true);
  assert.match(describeImportPlan(plan), /替换/);
});

test("a backup without an endpoint warns that it must be filled in", () => {
  const file = exportSettings({ ...SETTINGS, host: "", port: "" });
  const { plan } = planImport(JSON.stringify(file));
  assert.match(describeImportPlan(plan), /需要自己填/);
});

test("the filename is chronological and filesystem-safe", () => {
  const name = backupFilename(new Date(2026, 10, 23, 9, 5));
  assert.equal(name, "alaxee-proxy-20261123-0905.json");
  assert.match(name, /^[a-z0-9.-]+$/);
});
