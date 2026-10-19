#!/usr/bin/env node
// A stand-in e2e runner that records the selectors the red check hands it and runs nothing; RECORD_NO_REPORT=1
// makes it write no report, as a run that died before reporting does.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const io = process.env.E2E_IO_DIR;
appendFileSync(process.env.RECORD_SELECTION_TO, readFileSync(path.join(io, 'select.txt'), 'utf8'));
if (process.env.RECORD_NO_REPORT !== '1') writeFileSync(path.join(io, 'report.json'), JSON.stringify({ config: { configFile: path.join(process.cwd(), 'playwright.config.ts') }, suites: [], errors: [] }));
