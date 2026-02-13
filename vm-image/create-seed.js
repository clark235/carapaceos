#!/usr/bin/env node
/**
 * Create a NoCloud seed disk image for cloud-init (FAT12 format)
 * Pure Node.js - no external dependencies needed
 * 
 * Creates a raw disk image with FAT12 filesystem containing:
 * - meta-data
 * - user-data
 * 
 * Volume label: cidata (required by cloud-init NoCloud)
 */

const fs = require('fs');
const path = require('path');

const SECTOR_SIZE = 512;
const TOTAL_SECTORS = 2880; // 1.44MB floppy-sized
const FAT_SECTORS = 9;
const ROOT_DIR_SECTORS = 14;
const RESERVED_SECTORS = 1;
const CLUSTER_SIZE = 1; // sectors per cluster
const VOLUME_LABEL = 'cidata     '; // 11 chars, padded

function createFAT12Image(files) {
    const img = Buffer.alloc(TOTAL_SECTORS * SECTOR_SIZE, 0);
    
    // Boot sector (BPB)
    const bpb = Buffer.alloc(SECTOR_SIZE, 0);
    bpb[0] = 0xEB; bpb[1] = 0x3C; bpb[2] = 0x90; // JMP short
    Buffer.from('MSDOS5.0').copy(bpb, 3); // OEM name
    bpb.writeUInt16LE(SECTOR_SIZE, 11); // bytes per sector
    bpb[13] = CLUSTER_SIZE; // sectors per cluster
    bpb.writeUInt16LE(RESERVED_SECTORS, 14); // reserved sectors
    bpb[16] = 2; // number of FATs
    bpb.writeUInt16LE(ROOT_DIR_SECTORS * 16, 17); // root dir entries (16 per sector)
    bpb.writeUInt16LE(TOTAL_SECTORS, 19); // total sectors
    bpb[21] = 0xF0; // media descriptor (floppy)
    bpb.writeUInt16LE(FAT_SECTORS, 22); // sectors per FAT
    bpb.writeUInt16LE(18, 24); // sectors per track
    bpb.writeUInt16LE(2, 26); // number of heads
    bpb.writeUInt32LE(0, 28); // hidden sectors
    // Extended boot record
    bpb[36] = 0x00; // drive number
    bpb[38] = 0x29; // extended boot signature
    bpb.writeUInt32LE(0x12345678, 39); // volume serial
    Buffer.from(VOLUME_LABEL).copy(bpb, 43); // volume label
    Buffer.from('FAT12   ').copy(bpb, 54); // filesystem type
    bpb[510] = 0x55; bpb[511] = 0xAA; // boot signature
    bpb.copy(img, 0);
    
    // FAT tables (2 copies)
    const fatStart = RESERVED_SECTORS * SECTOR_SIZE;
    const fat2Start = (RESERVED_SECTORS + FAT_SECTORS) * SECTOR_SIZE;
    
    // First 3 bytes: media descriptor + 0xFF 0xFF
    img[fatStart] = 0xF0;
    img[fatStart + 1] = 0xFF;
    img[fatStart + 2] = 0xFF;
    img[fat2Start] = 0xF0;
    img[fat2Start + 1] = 0xFF;
    img[fat2Start + 2] = 0xFF;
    
    // Root directory
    const rootDirStart = (RESERVED_SECTORS + FAT_SECTORS * 2) * SECTOR_SIZE;
    const dataStart = rootDirStart + ROOT_DIR_SECTORS * SECTOR_SIZE;
    
    let dirOffset = 0;
    let nextCluster = 2; // first data cluster
    
    // Volume label entry
    const volEntry = Buffer.alloc(32, 0);
    Buffer.from(VOLUME_LABEL).copy(volEntry, 0);
    volEntry[11] = 0x08; // volume label attribute
    volEntry.copy(img, rootDirStart + dirOffset);
    dirOffset += 32;
    
    // Write each file
    for (const [filename, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf8');
        const clustersNeeded = Math.ceil(data.length / (CLUSTER_SIZE * SECTOR_SIZE)) || 1;
        
        // Directory entry
        const entry = Buffer.alloc(32, 0);
        const name83 = to83Name(filename);
        Buffer.from(name83).copy(entry, 0);
        entry[11] = 0x20; // archive attribute
        entry.writeUInt16LE(nextCluster, 26); // first cluster
        entry.writeUInt32LE(data.length, 28); // file size
        entry.copy(img, rootDirStart + dirOffset);
        dirOffset += 32;
        
        // Write data
        const fileDataStart = dataStart + (nextCluster - 2) * CLUSTER_SIZE * SECTOR_SIZE;
        data.copy(img, fileDataStart);
        
        // FAT chain
        for (let i = 0; i < clustersNeeded; i++) {
            const cluster = nextCluster + i;
            const nextInChain = (i === clustersNeeded - 1) ? 0xFFF : cluster + 1;
            setFAT12Entry(img, fatStart, cluster, nextInChain);
            setFAT12Entry(img, fat2Start, cluster, nextInChain);
        }
        
        nextCluster += clustersNeeded;
    }
    
    return img;
}

function to83Name(filename) {
    const dot = filename.lastIndexOf('.');
    let name, ext;
    if (dot >= 0) {
        name = filename.substring(0, dot).toUpperCase();
        ext = filename.substring(dot + 1).toUpperCase();
    } else {
        name = filename.toUpperCase();
        ext = '';
    }
    // Replace hyphens with valid chars
    name = name.replace(/-/g, '_');
    ext = ext.replace(/-/g, '_');
    return (name + '        ').substring(0, 8) + (ext + '   ').substring(0, 3);
}

function setFAT12Entry(img, fatOffset, cluster, value) {
    const byteOffset = fatOffset + Math.floor(cluster * 3 / 2);
    if (cluster % 2 === 0) {
        img[byteOffset] = value & 0xFF;
        img[byteOffset + 1] = (img[byteOffset + 1] & 0xF0) | ((value >> 8) & 0x0F);
    } else {
        img[byteOffset] = (img[byteOffset] & 0x0F) | ((value & 0x0F) << 4);
        img[byteOffset + 1] = (value >> 4) & 0xFF;
    }
}

// Main
const buildDir = path.join(__dirname, 'build', 'cidata');
const metaData = fs.readFileSync(path.join(buildDir, 'meta-data'), 'utf8');
const userData = fs.readFileSync(path.join(buildDir, 'user-data'), 'utf8');

const img = createFAT12Image({
    'meta-data': metaData,
    'user-data': userData,
});

const outputPath = path.join(__dirname, 'build', 'seed.img');
fs.writeFileSync(outputPath, img);
console.log(`✅ Created seed image: ${outputPath} (${img.length} bytes)`);
