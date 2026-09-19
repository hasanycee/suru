import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satirSonuNormal } from '../src/pty.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

test('LF ve CRLF terminalin bekledigi CR ye cevrilir', () => {
  // Regresyon: Enter LF olarak gelince komut yaziliyor ama CALISMIYORDU.
  // Kullanici Enter'a basiyor, hicbir sey olmuyor - sessiz ve can sikici.
  assert.equal(satirSonuNormal('ls' + LF), 'ls' + CR);
  assert.equal(satirSonuNormal('ls' + CR + LF), 'ls' + CR);
  assert.equal(satirSonuNormal('ls' + CR), 'ls' + CR, 'zaten CR ise bozulmaz');
});

test('cok satirli yapistirma her satiri CR ile biter', () => {
  assert.equal(satirSonuNormal('bir' + LF + 'iki' + LF), 'bir' + CR + 'iki' + CR);
});

test('siradan metin degismez', () => {
  assert.equal(satirSonuNormal('echo merhaba'), 'echo merhaba');
  assert.equal(satirSonuNormal(''), '');
});

test('bos girdi patlamaz', () => {
  assert.equal(satirSonuNormal(null), '');
  assert.equal(satirSonuNormal(undefined), '');
});

test('kontrol karakterleri korunur', () => {
  // Ctrl-C gibi diziler oldugu gibi gecmeli
  const ctrlC = String.fromCharCode(3);
  assert.equal(satirSonuNormal(ctrlC), ctrlC);
});
