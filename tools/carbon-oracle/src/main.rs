//! Carbon oracle (ap3x-engine PRP §11): decode the mainnet fixtures' Pump and
//! PumpSwap events with SevenLabs Carbon, an independent decoder, and print
//! one JSON line per event. `compare.mjs` diffs this against the TypeScript
//! decoders field by field.
//!
//!   cargo run --release -- <fixture.jsonl.gz>... > carbon.jsonl

use std::io::{BufRead, BufReader, Write};

use base64::Engine;
use flate2::read::GzDecoder;
use serde_json::{json, Value};

const PUMP: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
/// Anchor's event-CPI instruction tag, which Carbon's CpiEvent::decode expects first.
const EVENT_IX_TAG: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];

fn main() {
    let out = std::io::stdout();
    let mut out = out.lock();
    for path in std::env::args().skip(1) {
        let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("open {path}: {e}"));
        for line in BufReader::new(GzDecoder::new(file)).lines() {
            let line = line.expect("read fixture line");
            if line.trim().is_empty() {
                continue;
            }
            let tx: Value = serde_json::from_str(&line).expect("fixture line is JSON");
            let signature = tx["signature"].as_str().unwrap_or_default().to_string();
            let logs: Vec<String> = tx["logs"].as_array().map(|a| a.iter().filter_map(|l| l.as_str().map(String::from)).collect()).unwrap_or_default();
            for (index, (program, payload)) in event_payloads(&logs).into_iter().enumerate() {
                let decoded = decode(&program, &payload);
                let (event, fields) = match decoded {
                    Some((name, fields)) => (Value::String(name), fields),
                    None => (Value::Null, Value::Null),
                };
                let row = json!({ "signature": signature, "program": program, "index": index, "event": event, "fields": fields });
                writeln!(out, "{row}").expect("write");
            }
        }
    }
}

/// Every `Program data:` payload, with the program whose invocation emitted it.
fn event_payloads(logs: &[String]) -> Vec<(String, Vec<u8>)> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for l in logs {
        if let Some(rest) = l.strip_prefix("Program ") {
            if let Some(data) = rest.strip_prefix("data: ") {
                let mut bytes = Vec::new();
                for part in data.split(' ') {
                    if let Ok(b) = b64.decode(part) {
                        bytes.extend(b);
                    }
                }
                if let Some(p) = stack.last() {
                    if p == PUMP || p == PUMPSWAP {
                        out.push((p.clone(), bytes));
                    }
                }
            } else if let Some((id, tail)) = rest.split_once(' ') {
                if tail.starts_with("invoke [") {
                    stack.push(id.to_string());
                } else if tail == "success" || tail.starts_with("failed") {
                    stack.pop();
                }
            }
        }
    }
    out
}

/// Carbon's decoding of one event payload: (event name, fields), or None.
fn decode(program: &str, payload: &[u8]) -> Option<(String, Value)> {
    let mut data = EVENT_IX_TAG.to_vec();
    data.extend_from_slice(payload);
    let value = if program == PUMP {
        serde_json::to_value(carbon_pumpfun_decoder::instructions::cpi_event::CpiEvent::decode(&data)?).ok()?
    } else {
        serde_json::to_value(carbon_pump_swap_decoder::instructions::cpi_event::CpiEvent::decode(&data)?).ok()?
    };
    // Externally tagged enum: { "TradeEvent": { ... } }
    let (name, fields) = value.as_object()?.iter().next()?;
    Some((name.clone(), exact(fields.clone())))
}

/// Exact, comparable JSON: public keys (32-byte arrays) as base58, every
/// number as a decimal string (u64 does not survive a JavaScript number).
fn exact(v: Value) -> Value {
    match v {
        Value::Number(n) => Value::String(n.to_string()),
        Value::Array(a) if a.len() == 32 && a.iter().all(|x| x.as_u64().is_some_and(|b| b <= 255)) => {
            let bytes: Vec<u8> = a.iter().map(|x| x.as_u64().unwrap() as u8).collect();
            Value::String(bs58::encode(bytes).into_string())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(exact).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k, exact(x))).collect()),
        other => other,
    }
}
