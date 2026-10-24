import {test} from 'node:test';
import assert from 'node:assert/strict';
import {greeting,retryCount} from './greeting.js';
test('names remain in greeting',()=>assert.ok(greeting('Ada').includes('Ada')));
test('retry policy in CI',()=>{if(process.env.CI) assert.equal(retryCount,2)});
