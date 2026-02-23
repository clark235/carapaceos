/**
 * CarapaceOS — Runtime Cloud-Init Seed ISO Generator
 *
 * Creates a minimal ISO 9660 (NoCloud format) seed image entirely in Node.js.
 * Zero external dependencies — no genisoimage, mkisofs, or xorriso needed.
 *
 * The ISO contains two files:
 *   - meta-data  (cloud-init instance metadata)
 *   - user-data  (cloud-config: SSH key injection + optional setup)
 *
 * ISO 9660 structure:
 *   Sectors 0-15:   System area (zeros)
 *   Sector 16:      Primary Volume Descriptor (PVD)
 *   Sector 17:      Volume Descriptor Set Terminator
 *   Sector 18:      Path table (LSB)
 *   Sector 19:      Path table (MSB)
 *   Sector 20:      Root directory
 *   Sector 21+:     File data (meta-data, user-data)
 *
 * Usage:
 *   import { createSeedISO } from './lib/seed-iso.js';
 *   createSeedISO({ sshPublicKey: '...', outputPath: '/tmp/seed.iso' });
 */

import { writeFileSync } from 'fs';

const SECTOR_SIZE = 2048;

// ─── Buffer helpers ──────────────────────────────────────────────────────────

function padToSector(buf) {
  const rem = buf.length % SECTOR_SIZE;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(SECTOR_SIZE - rem)]);
}

/** ISO 9660 d-characters field, space-padded */
function strD(str, len) {
  const b = Buffer.alloc(len, 0x20);
  b.write(str.substring(0, len), 'ascii');
  return b;
}

/** ISO 9660 a-characters field (uppercase), space-padded */
function strA(str, len) {
  const b = Buffer.alloc(len, 0x20);
  b.write(str.toUpperCase().substring(0, len), 'ascii');
  return b;
}

function int32LSB(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function int32MSB(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function int32LSBMSB(n) {
  return Buffer.concat([int32LSB(n), int32MSB(n)]);
}

function int16LSBMSB(n) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(n, 0);
  b.writeUInt16BE(n, 2);
  return b;
}

/** ISO 9660 17-byte decimal datetime */
function decDateTime(d = new Date()) {
  const b = Buffer.alloc(17, 0x30);
  b.write(String(d.getUTCFullYear()), 0);
  b.write(String(d.getUTCMonth() + 1).padStart(2, '0'), 4);
  b.write(String(d.getUTCDate()).padStart(2, '0'), 6);
  b.write(String(d.getUTCHours()).padStart(2, '0'), 8);
  b.write(String(d.getUTCMinutes()).padStart(2, '0'), 10);
  b.write(String(d.getUTCSeconds()).padStart(2, '0'), 12);
  b.write('00', 14);
  b[16] = 0; // UTC
  return b;
}

/** ISO 9660 7-byte directory recording date */
function dirDateTime(d = new Date()) {
  const b = Buffer.alloc(7);
  b[0] = d.getUTCFullYear() - 1900;
  b[1] = d.getUTCMonth() + 1;
  b[2] = d.getUTCDate();
  b[3] = d.getUTCHours();
  b[4] = d.getUTCMinutes();
  b[5] = d.getUTCSeconds();
  b[6] = 0; // UTC
  return b;
}

/** ISO 9660 directory record */
function dirRecord(name, extentLBA, dataLength, isDir, date) {
  const nameBytes = Buffer.from(name, 'ascii');
  const nameLen = nameBytes.length;
  let recLen = 33 + nameLen;
  if (recLen % 2 !== 0) recLen++;

  const rec = Buffer.alloc(recLen);
  rec[0] = recLen;
  rec[1] = 0; // extended attr len
  int32LSBMSB(extentLBA).copy(rec, 2);
  int32LSBMSB(dataLength).copy(rec, 10);
  dirDateTime(date instanceof Date ? date : undefined).copy(rec, 18);
  rec[25] = isDir ? 0x02 : 0x00; // flags
  rec[26] = 0; rec[27] = 0;      // file unit size / interleave
  int16LSBMSB(1).copy(rec, 28);  // volume seq number
  rec[32] = nameLen;
  nameBytes.copy(rec, 33);

  return rec;
}

// ─── ISO 9660 Builder ────────────────────────────────────────────────────────

/**
 * Build a cloud-init NoCloud seed ISO from file buffers.
 *
 * @param {Array<{name: string, isoName: string, content: Buffer|string}>} files
 * @param {string} outputPath - Where to write the ISO
 * @param {string} [volumeLabel='cidata'] - ISO volume label (must be 'cidata' for cloud-init)
 */
export function buildISO(files, outputPath, volumeLabel = 'cidata') {
  const now = new Date();

  // Layout: system(16) + PVD(1) + VDST(1) + ptL(1) + ptM(1) + rootDir(1) = 21 sectors before data
  const DATA_START_SECTOR = 21;

  // Convert all content to Buffers
  const fileData = files.map(f => ({
    ...f,
    content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'),
  }));

  // Assign LBAs
  let nextSector = DATA_START_SECTOR;
  for (const f of fileData) {
    f.lba = nextSector;
    f.sectors = Math.ceil(f.content.length / SECTOR_SIZE);
    nextSector += f.sectors;
  }
  const totalSectors = nextSector;

  // ── Root directory ──────────────────────────────────────────────────────
  const DOT_LBA = 20; // root dir sector

  let rootDir = Buffer.alloc(0);
  // . entry
  rootDir = Buffer.concat([rootDir, dirRecord('\x00', DOT_LBA, SECTOR_SIZE, true, now)]);
  // .. entry (same as . for root)
  rootDir = Buffer.concat([rootDir, dirRecord('\x01', DOT_LBA, SECTOR_SIZE, true, now)]);
  // files
  for (const f of fileData) {
    rootDir = Buffer.concat([rootDir, dirRecord(f.isoName, f.lba, f.content.length, false, now)]);
  }
  const rootDirPadded = padToSector(rootDir);

  // ── Path tables ─────────────────────────────────────────────────────────
  // Minimal: just the root directory entry
  // LSB path table
  const ptL = Buffer.alloc(10);
  ptL[0] = 1;                   // dir identifier length
  ptL[1] = 0;                   // extended attr length
  ptL.writeUInt32LE(DOT_LBA, 2); // location of extent
  ptL.writeUInt16LE(1, 6);       // dir number of parent (1 = root)
  ptL[8] = 0x00;                 // dir identifier: root (\x00)
  ptL[9] = 0x00;                 // padding

  // MSB path table
  const ptM = Buffer.alloc(10);
  ptM[0] = 1;
  ptM[1] = 0;
  ptM.writeUInt32BE(DOT_LBA, 2);
  ptM.writeUInt16BE(1, 6);
  ptM[8] = 0x00;
  ptM[9] = 0x00;

  // ── Primary Volume Descriptor (sector 16) ─────────────────────────────
  const pvd = Buffer.alloc(SECTOR_SIZE);
  pvd[0] = 1;                              // Type: Primary
  pvd.write('CD001', 1, 'ascii');          // Standard identifier
  pvd[6] = 1;                              // Version
  // Unused byte 7
  strA(' ', 32).copy(pvd, 8);             // System identifier
  strD(volumeLabel.toUpperCase(), 32).copy(pvd, 40); // Volume identifier
  // Bytes 72-79: unused
  int32LSBMSB(totalSectors).copy(pvd, 80); // Volume space size
  // Bytes 88-119: escape sequences (unused for ISO 9660)
  int16LSBMSB(1).copy(pvd, 120);          // Volume set size
  int16LSBMSB(1).copy(pvd, 124);          // Volume sequence number
  int16LSBMSB(SECTOR_SIZE).copy(pvd, 128); // Logical block size
  const ptSize = ptL.length;
  int32LSBMSB(ptSize).copy(pvd, 132);     // Path table size
  pvd.writeUInt32LE(18, 140);             // LSB path table location (sector 18)
  pvd.writeUInt32LE(0, 144);             // Optional LSB path table
  pvd.writeUInt32BE(19, 148);             // MSB path table location (sector 19)
  pvd.writeUInt32BE(0, 152);             // Optional MSB path table

  // Root directory record (34 bytes at offset 156)
  const rootDirRec = dirRecord('\x00', DOT_LBA, rootDirPadded.length, true, now);
  rootDirRec.copy(pvd, 156);

  strD(' ', 128).copy(pvd, 190);          // Volume set identifier
  strA('', 128).copy(pvd, 318);          // Publisher identifier
  strA('', 128).copy(pvd, 446);          // Data preparer
  strA('CARAPACEOS', 128).copy(pvd, 574); // Application identifier
  // File identifiers: empty
  decDateTime(now).copy(pvd, 813);        // Volume creation date
  decDateTime(now).copy(pvd, 830);        // Volume modification date
  Buffer.alloc(17, 0x30).copy(pvd, 847); // Volume expiration (never)
  decDateTime(now).copy(pvd, 864);        // Volume effective
  pvd[881] = 1;                           // File structure version

  // ── Volume Descriptor Set Terminator (sector 17) ──────────────────────
  const vdst = Buffer.alloc(SECTOR_SIZE);
  vdst[0] = 255;
  vdst.write('CD001', 1, 'ascii');
  vdst[6] = 1;

  // ── Assemble ───────────────────────────────────────────────────────────
  const parts = [
    Buffer.alloc(16 * SECTOR_SIZE),   // System area (sectors 0-15)
    pvd,                               // Sector 16
    vdst,                              // Sector 17
    padToSector(ptL),                  // Sector 18
    padToSector(ptM),                  // Sector 19
    rootDirPadded,                     // Sector 20
  ];

  for (const f of fileData) {
    parts.push(padToSector(f.content));
  }

  writeFileSync(outputPath, Buffer.concat(parts));
}

// ─── High-level: create cloud-init seed ─────────────────────────────────────

/**
 * Create a cloud-init NoCloud seed ISO with SSH key injection.
 *
 * @param {object} opts
 * @param {string} opts.sshPublicKey - SSH public key to inject
 * @param {string} opts.outputPath - Where to write the ISO file
 * @param {string} [opts.hostname='carapaceos'] - VM hostname
 * @param {string} [opts.instanceId] - cloud-init instance-id (random if omitted)
 * @param {string[]} [opts.runcmd=[]] - Extra shell commands to run on first boot
 */
export function createSeedISO({ sshPublicKey, outputPath, hostname = 'carapaceos', instanceId, runcmd = [] }) {
  if (!sshPublicKey) throw new Error('sshPublicKey is required');
  if (!outputPath) throw new Error('outputPath is required');

  const iid = instanceId || `carapaceos-${Date.now()}`;

  const metaData = [
    `instance-id: ${iid}`,
    `local-hostname: ${hostname}`,
  ].join('\n') + '\n';

  const runcmdLines = [
    '  - echo "CARAPACEOS_READY" > /dev/ttyS0',
    ...runcmd.map(cmd => `  - ${JSON.stringify(cmd)}`),
  ];

  const userData = [
    '#cloud-config',
    'ssh_authorized_keys:',
    `  - ${sshPublicKey.trim()}`,
    'ssh_pwauth: false',
    'runcmd:',
    ...runcmdLines,
  ].join('\n') + '\n';

  buildISO(
    [
      { name: 'meta-data', isoName: 'META-DATA.;1', content: metaData },
      { name: 'user-data', isoName: 'USER-DATA.;1', content: userData },
    ],
    outputPath,
  );
}

// ─── CLI entrypoint (for testing) ────────────────────────────────────────────
// node lib/seed-iso.js <pubkey> <output.iso>

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , pubkey, out] = process.argv;
  if (!pubkey || !out) {
    console.error('Usage: node seed-iso.js <ssh-pubkey> <output.iso>');
    process.exit(1);
  }
  createSeedISO({ sshPublicKey: pubkey, outputPath: out });
  console.log(`✅ Seed ISO written to ${out}`);
}
