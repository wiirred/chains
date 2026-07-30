#!/usr/bin/env node
/*
 * Local stand-in for `./gradlew run` (processor/src/main/kotlin/.../Main.kt).
 * The Gradle path needs KEthereum from jitpack.io, which this environment's
 * network policy blocks, so the offline checks from checkChain() are
 * replicated here 1:1. Online checks (rpcConnect / iconDownload) are NOT
 * replicated - they need network the sandbox does not have.
 */
const fs = require("fs")
const path = require("path")

const base = path.resolve(__dirname, "..")
const dataPath = path.join(base, "_data")
const chainsPath = path.join(dataPath, "chains")
const iconsPath = path.join(dataPath, "icons")
const iconsDownloadPath = path.join(dataPath, "iconsDownload")

const MANDATORY = ["name", "shortName", "chain", "chainId", "networkId", "rpc", "faucets", "infoURL", "nativeCurrency"]
const OPTIONAL = ["features", "slip44", "ens", "icon", "explorers", "title", "parent", "status", "redFlags"]
const ALLOWED_RED_FLAGS = ["reusedChainId"]
const HTTP_PREFIXES = ["https://", "http://"]
const RPC_PREFIXES = [...HTTP_PREFIXES, "wss://", "ws://"]
const NAME_RE = /^[a-zA-Z0-9\-.() ]+$/

const errors = []
const seenNames = new Map()
const seenShortNames = new Map()
const usedIcons = new Set()
const iconCIDs = new Set()

const normalize = (s) => s.replace(/ /g, "").toUpperCase()
const err = (file, msg) => errors.push(`${path.basename(file)}: ${msg}`)

function checkString(file, which, s) {
  if (!s || !s.trim()) err(file, `${which} cannot be blank`)
  else if (s.trim() !== s) err(file, `${which} cannot have extra spaces`)
}

function processIcon(file, icon) {
  if (typeof icon !== "string") return err(file, "icon must be string")
  if (!fs.existsSync(path.join(iconsPath, `${icon}.json`))) err(file, `icon ${icon} does not exist`)
  usedIcons.add(icon)
}

function checkChain(file) {
  const raw = fs.readFileSync(file, "utf8")
  let o
  try { o = JSON.parse(raw) } catch (e) { return err(file, `unparseable: ${e.message}`) }

  const stem = path.basename(file, ".json")
  if (!stem.startsWith("eip155-")) return err(file, "unsupported namespace")
  if (typeof o.chainId !== "number") return err(file, "chainId not a number")
  if (String(o.chainId) !== stem.replace("eip155-", "")) err(file, "file name must match chainId")
  if (typeof o.networkId !== "number") err(file, "networkId not a number")

  const keys = Object.keys(o)
  const extra = keys.filter((k) => !MANDATORY.includes(k) && !OPTIONAL.includes(k))
  if (extra.length) err(file, `extra fields: ${extra.join(", ")}`)
  const missing = MANDATORY.filter((k) => !keys.includes(k))
  if (missing.length) err(file, `missing fields: ${missing.join(", ")}`)

  if (o.icon !== undefined) processIcon(file, o.icon)

  const nc = o.nativeCurrency
  if (nc !== undefined) {
    if (typeof nc !== "object" || nc === null || Array.isArray(nc)) err(file, "nativeCurrency must be object")
    else {
      if (typeof nc.symbol !== "string") err(file, "nativeCurrency symbol must be string")
      else {
        if (nc.symbol.trim() !== nc.symbol) err(file, "nativeCurrency symbol cannot be trimmed")
        if (nc.symbol.length >= 7) err(file, "nativeCurrency symbol must be < 7 chars")
      }
      const k = Object.keys(nc).sort().join(",")
      if (k !== "decimals,name,symbol") err(file, "nativeCurrency can only have symbol, name, decimals")
      if (!Number.isInteger(nc.decimals)) err(file, "nativeCurrency decimals must be int")
      if (typeof nc.name !== "string") err(file, "nativeCurrency name must be string")
      else if (!NAME_RE.test(nc.name)) err(file, `illegal currencyName: ${nc.name}`)
    }
  }

  if (typeof o.name !== "string") err(file, "chain name must be string")
  else if (!NAME_RE.test(o.name)) err(file, `illegal chain name: ${o.name}`)

  if (o.explorers !== undefined) {
    if (!Array.isArray(o.explorers)) err(file, "explorers must be array")
    else o.explorers.forEach((ex) => {
      if (typeof ex !== "object" || ex === null) return err(file, "explorer must be object")
      if (ex.name == null) err(file, "explorer must have name")
      if (ex.icon !== undefined) processIcon(file, ex.icon)
      const url = ex.url
      if (typeof url !== "string" || !HTTP_PREFIXES.some((p) => url.startsWith(p))) {
        err(file, "explorer url must start with https:// or http://")
      } else {
        if (url.endsWith("/")) err(file, "explorer url cannot end in slash")
        checkString(file, "Explorer URL", url)
      }
      if (ex.standard !== "EIP3091" && ex.standard !== "none") err(file, "explorer standard must be EIP3091 or none")
    })
  }

  if (o.ens !== undefined) {
    if (typeof o.ens !== "object" || o.ens === null) err(file, "ens must be object")
    else if (Object.keys(o.ens).join(",") !== "registry") err(file, "ens must have only registry")
    else if (!/^0x[0-9a-fA-F]{40}$/.test(o.ens.registry)) err(file, "ens registry must be valid address")
  }

  if (o.status !== undefined) {
    if (typeof o.status !== "string") err(file, "status must be string")
    else if (!["incubating", "active", "deprecated"].includes(o.status)) {
      err(file, "status must be incubating, active or deprecated")
    }
  }

  if (o.faucets !== undefined) {
    if (!Array.isArray(o.faucets)) err(file, "faucets must be array")
    else o.faucets.forEach((f) => {
      if (typeof f !== "string") err(file, "faucet must be string")
      else checkString(file, "Faucet URL", f)
    })
  }

  if (o.redFlags !== undefined) {
    if (!Array.isArray(o.redFlags)) err(file, "redFlags must be array")
    else o.redFlags.forEach((f) => {
      if (typeof f !== "string") return err(file, "redFlag must be string")
      checkString(file, "Red flag", f)
      if (!ALLOWED_RED_FLAGS.includes(f)) err(file, `invalid redFlag: ${f}`)
    })
  }

  if (o.parent !== undefined) {
    const p = o.parent
    if (typeof p !== "object" || p === null) err(file, "parent must be object")
    else {
      if (!("chain" in p) || !("type" in p)) err(file, "parent must have chain and type")
      const pe = Object.keys(p).filter((k) => !["chain", "type", "bridges"].includes(k))
      if (pe.length) err(file, `parent has extra fields: ${pe.join(", ")}`)
      if (p.bridges !== undefined) {
        if (!Array.isArray(p.bridges)) err(file, "parent bridges must be array")
        else p.bridges.forEach((b) => {
          if (typeof b !== "object" || b === null) err(file, "bridge must be object")
          else if (Object.keys(b).length !== 1 || Object.keys(b)[0] !== "url") err(file, "bridge only url")
        })
      }
      if (!["L2", "shard"].includes(p.type)) err(file, `parent has invalid type: ${p.type}`)
      if (typeof p.chain === "string" && !fs.existsSync(path.join(chainsPath, `${p.chain}.json`))) {
        err(file, `parent chain does not exist: ${p.chain}`)
      }
    }
  }

  // moshi: name + shortName uniqueness
  if (typeof o.name === "string") {
    const n = normalize(o.name)
    if (seenNames.has(n)) err(file, `name must be unique: ${n} (also in ${seenNames.get(n)})`)
    else seenNames.set(n, path.basename(file))
  }
  if (typeof o.shortName === "string") {
    const sn = normalize(o.shortName)
    if (sn === "*") err(file, "shortName must not be star")
    if (seenShortNames.has(sn)) err(file, `shortName must be unique: ${sn} (also in ${seenShortNames.get(sn)})`)
    else seenShortNames.set(sn, path.basename(file))
  }

  if (!Array.isArray(o.rpc)) err(file, "rpc must be list")
  else o.rpc.forEach((u) => {
    if (typeof u !== "string") err(file, "rpc must be list of strings")
    else if (!RPC_PREFIXES.some((p) => u.startsWith(p))) err(file, `invalid rpc prefix: ${u}`)
    else checkString(file, "RPC URL", u)
  })
}

function checkIcons() {
  if (!fs.existsSync(iconsPath)) return
  for (const f of fs.readdirSync(iconsPath)) {
    const p = path.join(iconsPath, f)
    if (path.extname(f) !== ".json") { errors.push(`icons/${f}: icon must be json`); continue }
    let arr
    try { arr = JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { errors.push(`icons/${f}: ${e.message}`); continue }
    if (!Array.isArray(arr)) { errors.push(`icons/${f}: must be array`); continue }
    for (const v of arr) {
      if (typeof v !== "object" || v === null) { errors.push(`icons/${f}: variant must be object`); continue }
      const url = v.url
      if (typeof url !== "string" || !url.startsWith("ipfs://")) { errors.push(`icons/${f}: url must start with ipfs://`); continue }
      iconCIDs.add(url.replace("ipfs://", ""))
      const hasW = v.width != null, hasH = v.height != null
      if (hasW !== hasH) errors.push(`icons/${f}: needs both width and height`)
      if (hasW && !Number.isInteger(v.width)) errors.push(`icons/${f}: width must be int`)
      if (hasH && !Number.isInteger(v.height)) errors.push(`icons/${f}: height must be int`)
      if (!["png", "svg", "jpg"].includes(v.format)) errors.push(`icons/${f}: format must be png, svg or jpg but was ${v.format}`)
    }
  }
  const unusedDownloads = []
  if (fs.existsSync(iconsDownloadPath)) {
    for (const f of fs.readdirSync(iconsDownloadPath)) if (!iconCIDs.has(f)) unusedDownloads.push(f)
  }
  if (unusedDownloads.length) errors.push(`unreferenced icon downloads: ${unusedDownloads.join(" ")}`)
  const unusedIcons = []
  for (const f of fs.readdirSync(iconsPath)) {
    if (!usedIcons.has(path.basename(f, ".json"))) unusedIcons.push(f)
  }
  if (unusedIcons.length) errors.push(`unused icons: ${unusedIcons.join(" ")}`)
}

const only = process.argv[2]
const files = fs.readdirSync(chainsPath)
  .filter((f) => !fs.statSync(path.join(chainsPath, f)).isDirectory())
  .sort()

for (const f of files) checkChain(path.join(chainsPath, f))
if (!only) checkIcons()

if (only) {
  const scoped = errors.filter((e) => e.startsWith(path.basename(only)))
  if (scoped.length) { scoped.forEach((e) => console.error("  ✗ " + e)); process.exit(1) }
  console.log(`✓ ${path.basename(only)} passes all offline checkChain() rules`)
  process.exit(0)
}

console.log(`checked ${files.length} chain files`)
if (errors.length) { errors.forEach((e) => console.error("  ✗ " + e)); process.exit(1) }
console.log("✓ all offline checks pass")
