#!/usr/bin/env python3
"""Create cloud-init seed ISO for CarapaceOS (NoCloud datasource)."""
import pycdlib
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CIDATA_DIR = os.path.join(SCRIPT_DIR, 'build', 'cidata')
OUTPUT = os.path.join(SCRIPT_DIR, 'build', 'seed.iso')

def main():
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    
    meta_path = os.path.join(CIDATA_DIR, 'meta-data')
    user_path = os.path.join(CIDATA_DIR, 'user-data')
    
    for p in [meta_path, user_path]:
        if not os.path.exists(p):
            print(f"❌ Missing: {p}")
            sys.exit(1)
    
    meta_size = os.path.getsize(meta_path)
    user_size = os.path.getsize(user_path)
    
    iso = pycdlib.PyCdlib()
    iso.new(vol_ident='cidata', rock_ridge='1.09')
    iso.add_fp(open(meta_path, 'rb'), meta_size, '/METADAT.;1', rr_name='meta-data')
    iso.add_fp(open(user_path, 'rb'), user_size, '/USERDAT.;1', rr_name='user-data')
    iso.write(OUTPUT)
    iso.close()
    
    print(f"✅ seed.iso created: {OUTPUT} ({os.path.getsize(OUTPUT)} bytes)")

if __name__ == '__main__':
    main()
