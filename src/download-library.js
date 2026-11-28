'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

function createDownloadLibrary(indexPath) {
  function read() {
    try {
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('Invalid Downloads index');
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function write(entries) {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const temp = indexPath + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(entries), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, indexPath);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  function add(filePath, title) {
    const address = path.resolve(filePath);
    const file = fs.statSync(address);
    if (!file.isFile()) throw new Error('Choose a video file');
    const entries = read();
    const previous = entries.find(entry => process.platform === 'win32'
      ? entry.filePath.toLowerCase() === address.toLowerCase() : entry.filePath === address);
    const entry = {
      id: previous?.id || randomUUID(),
      filePath: address,
      title: title || previous?.title || path.parse(address).name,
      bytes: file.size,
      savedAt: Date.now(),
    };
    write([entry, ...entries.filter(item => item !== previous)]);
  }

  function list() {
    return read().map(({ id, title, bytes, savedAt }) => ({ id, title, bytes, savedAt }));
  }

  function open(id) {
    const entry = read().find(item => item.id === id);
    if (!entry) throw new Error('Video is not in Downloads');
    if (!fs.statSync(entry.filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Video file moved or deleted. Use Add video to choose its new location.');
    }
    return { title: entry.title, url: pathToFileURL(entry.filePath).href };
  }

  function remove(id) {
    const entries = read();
    const remaining = entries.filter(entry => entry.id !== id);
    if (remaining.length !== entries.length) write(remaining);
  }

  return { add, list, open, remove };
}

module.exports = { createDownloadLibrary };
