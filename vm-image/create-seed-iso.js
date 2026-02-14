#!/usr/bin/env node
/**
 * CarapaceOS - Minimal ISO9660 seed creator for cloud-init NoCloud
 * Creates a proper ISO 9660 image with volume label "cidata" 
 * containing meta-data and user-data files.
 * 
 * ISO 9660 structure (simplified, no extensions):
 * - Sector 0-15: System area (zeros)
 * - Sector 16: Primary Volume Descriptor
 * - Sector 17: Volume Descriptor Set Terminator
 * - Sector 18: Root directory
 * - Sector 19+: File data
 */

const fs = require('fs');
const path = require('path');

const SECTOR_SIZE = 2048;

function padToSector(buf) {
  const rem = buf.length % SECTOR_SIZE;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(SECTOR_SIZE - rem)]);
}

function strA(str, len) {
  // ISO 9660 "a-characters" — padded with spaces
  const b = Buffer.alloc(len, 0x20);
  b.write(str.toUpperCase().substring(0, len), 'ascii');
  return b;
}

function strD(str, len) {
  const b = Buffer.alloc(len, 0x20);
  b.write(str.substring(0, len), 'ascii');
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

function decDateTime() {
  // 17 bytes: YYYYMMDDHHMMSScc + timezone offset
  const b = Buffer.alloc(17, 0x30); // '0' chars
  b.write('2026', 0);
  b.write('02', 4);
  b.write('14', 6);
  b.write('00', 8);
  b.write('00', 10);
  b.write('00', 12);
  b.write('00', 14);
  b[16] = 0; // UTC
  return b;
}

function dirDateTime() {
  // 7-byte recording date
  const b = Buffer.alloc(7);
  b[0] = 126;  // years since 1900 (2026)
  b[1] = 2;    // month
  b[2] = 14;   // day
  b[3] = 0;    // hour
  b[4] = 0;    // minute
  b[5] = 0;    // second
  b[6] = 0;    // timezone (UTC)
  return b;
}

function createDirectoryRecord(name, extentLBA, dataLength, isDir) {
  const nameBytes = Buffer.from(name, 'ascii');
  const nameLen = nameBytes.length;
  let recLen = 33 + nameLen;
  if (recLen % 2 !== 0) recLen++; // pad to even
  
  const rec = Buffer.alloc(recLen);
  rec[0] = recLen;                          // Length of directory record
  rec[1] = 0;                               // Extended attribute record length
  int32LSBMSB(extentLBA).copy(rec, 2);     // Location of extent
  int32LSBMSB(dataLength).copy(rec, 10);   // Data length
  dirDateTime().copy(rec, 18);              // Recording date
  rec[25] = isDir ? 0x02 : 0x00;           // File flags (directory bit)
  rec[26] = 0;                              // File unit size
  rec[27] = 0;                              // Interleave gap size
  int16LSBMSB(1).copy(rec, 28);            // Volume sequence number
  rec[32] = nameLen;                        // Length of file identifier
  nameBytes.copy(rec, 33);                  // File identifier
  return rec;
}

function buildISO(files, outputPath) {
  // files: [{name: 'META_DATA.;1', content: Buffer}, ...]
  
  // Layout:
  // Sectors 0-15: System area
  // Sector 16: Primary Volume Descriptor
  // Sector 17: Volume Descriptor Set Terminator
  // Sector 18: Path table (L)
  // Sector 19: Path table (M)  
  // Sector 20: Root directory
  // Sector 21+: File contents
  
  const ROOT_DIR_LBA = 20;
  
  // Calculate file placement
  let nextLBA = 21;
  const filePlacements = files.map(f => {
    const lba = nextLBA;
    const sectors = Math.ceil(f.content.length / SECTOR_SIZE) || 1;
    nextLBA += sectors;
    return { ...f, lba, sectors };
  });
  
  const totalSectors = nextLBA;
  
  // Build root directory
  const dotEntry = createDirectoryRecord('\x00', ROOT_DIR_LBA, SECTOR_SIZE, true);
  const dotdotEntry = createDirectoryRecord('\x01', ROOT_DIR_LBA, SECTOR_SIZE, true);
  
  const fileEntries = filePlacements.map(f => 
    createDirectoryRecord(f.isoName, f.lba, f.content.length, false)
  );
  
  const rootDirData = Buffer.concat([dotEntry, dotdotEntry, ...fileEntries]);
  const rootDirPadded = padToSector(rootDirData);
  const rootDirSectors = rootDirPadded.length / SECTOR_SIZE;
  
  // Recalculate — root dir may be > 1 sector
  // For simplicity, keep it at 1 sector (our files are tiny)
  
  // Build path table (Little-endian)
  const ptL = Buffer.alloc(10);
  ptL[0] = 1;    // Length of directory identifier (root = 1)
  ptL[1] = 0;    // Extended attribute record length
  ptL.writeUInt32LE(ROOT_DIR_LBA, 2);  // Location of extent
  ptL.writeUInt16LE(1, 6);             // Parent directory number
  ptL[8] = 0x00;                        // Root directory identifier (one byte)
  ptL[9] = 0x00;                        // Padding
  
  // Path table (Big-endian)
  const ptM = Buffer.alloc(10);
  ptM[0] = 1;
  ptM[1] = 0;
  ptM.writeUInt32BE(ROOT_DIR_LBA, 2);
  ptM.writeUInt16BE(1, 6);
  ptM[8] = 0x00;
  ptM[9] = 0x00;
  
  // Primary Volume Descriptor (sector 16)
  const pvd = Buffer.alloc(SECTOR_SIZE);
  pvd[0] = 1;                                           // Type: Primary
  pvd.write('CD001', 1, 'ascii');                       // Standard identifier
  pvd[6] = 1;                                           // Version
  pvd[7] = 0;                                           // Unused
  strA('LINUX', 32).copy(pvd, 8);                       // System identifier
  strD('cidata', 32).copy(pvd, 40);                     // Volume identifier ← KEY!
  // 72-79: unused
  int32LSBMSB(totalSectors).copy(pvd, 80);             // Volume space size
  // 88-119: unused (escape sequences for supplementary)
  int16LSBMSB(1).copy(pvd, 120);                       // Volume set size
  int16LSBMSB(1).copy(pvd, 124);                       // Volume sequence number
  int16LSBMSB(SECTOR_SIZE).copy(pvd, 128);             // Logical block size
  int32LSBMSB(ptL.length).copy(pvd, 132);              // Path table size
  pvd.writeUInt32LE(18, 140);                           // L path table location
  pvd.writeUInt32LE(0, 144);                            // Optional L path table
  pvd.writeUInt32BE(19, 148);                           // M path table location
  pvd.writeUInt32BE(0, 152);                            // Optional M path table
  // Root directory record (34 bytes at offset 156)
  const rootRec = createDirectoryRecord('\x00', ROOT_DIR_LBA, rootDirPadded.length, true);
  rootRec.copy(pvd, 156);
  strD('CARAPACEOS', 128).copy(pvd, 190);               // Volume set identifier
  strA('', 128).copy(pvd, 318);                         // Publisher
  strA('', 128).copy(pvd, 446);                         // Data preparer
  strA('CARAPACEOS_SEED', 128).copy(pvd, 574);         // Application
  strD('', 37).copy(pvd, 702);                          // Copyright file
  strD('', 37).copy(pvd, 739);                          // Abstract file
  strD('', 37).copy(pvd, 776);                          // Bibliographic file
  decDateTime().copy(pvd, 813);                         // Volume creation
  decDateTime().copy(pvd, 830);                         // Volume modification
  Buffer.alloc(17, 0x30).copy(pvd, 847);                // Volume expiration
  decDateTime().copy(pvd, 864);                         // Volume effective
  pvd[881] = 1;                                         // File structure version
  
  // Volume Descriptor Set Terminator (sector 17)
  const vdst = Buffer.alloc(SECTOR_SIZE);
  vdst[0] = 255;                                        // Type: Terminator
  vdst.write('CD001', 1, 'ascii');
  vdst[6] = 1;
  
  // Assemble the image
  const systemArea = Buffer.alloc(16 * SECTOR_SIZE);    // Sectors 0-15
  const pathTableL = padToSector(ptL);                   // Sector 18
  const pathTableM = padToSector(ptM);                   // Sector 19
  
  const parts = [systemArea, pvd, vdst, pathTableL, pathTableM, rootDirPadded];
  
  for (const f of filePlacements) {
    parts.push(padToSector(f.content));
  }
  
  const iso = Buffer.concat(parts);
  fs.writeFileSync(outputPath, iso);
  console.log(`✅ ISO created: ${outputPath} (${iso.length} bytes, ${totalSectors} sectors)`);
}

// Read cloud-init files
const cidataDir = path.join(__dirname, 'build', 'cidata');
if (!fs.existsSync(cidataDir)) {
  // Create from build-rootfs.sh cloud-init data
  console.log('Reading cloud-init files from build/cidata/');
}

const metaData = fs.readFileSync(path.join(cidataDir, 'meta-data'));
const userData = fs.readFileSync(path.join(cidataDir, 'user-data'));

const files = [
  { name: 'meta-data', isoName: 'META-DATA.;1', content: metaData },
  { name: 'user-data', isoName: 'USER-DATA.;1', content: userData },
];

const outputPath = path.join(__dirname, 'build', 'seed.iso');
buildISO(files, outputPath);
