import sys

def get_pts_list(filename):
    with open(filename, 'rb') as f:
        data = f.read()
        
    pts_list = []
    
    for i in range(0, len(data), 188):
        packet = data[i:i+188]
        if len(packet) < 188 or packet[0] != 0x47: continue
        pusi = (packet[1] & 0x40) != 0
        if not pusi: continue
        has_adapt = (packet[3] & 0x20) != 0
        has_payload = (packet[3] & 0x10) != 0
        if not has_payload: continue
        
        payload_offset = 4
        if has_adapt:
            payload_offset += 1 + packet[4]
            
        if payload_offset + 9 > 188: continue
        
        if packet[payload_offset] != 0 or packet[payload_offset+1] != 0 or packet[payload_offset+2] != 1: continue
            
        pts_dts_flag = (packet[payload_offset+7] & 0xC0) >> 6
        if pts_dts_flag >= 2:
            pts_bytes = packet[payload_offset+9:payload_offset+14]
            pts = ((pts_bytes[0] & 0x0E) << 29) | (pts_bytes[1] << 22) | ((pts_bytes[2] & 0xFE) << 14) | (pts_bytes[3] << 7) | ((pts_bytes[4] & 0xFE) >> 1)
            pts_list.append(pts / 90000.0)
            
    return pts_list

pts = get_pts_list("clips/sync_reports/ts_segments_source/1696/seg_00000.ts")
print(f"Source frame PTS: len={len(pts)}")
if pts:
    print(f"First 10: {pts[:10]}")
    print(f"Last 10: {pts[-10:]}")
