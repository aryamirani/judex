import re

with open('tri_stream_server2.py', 'r') as f:
    content = f.read()

def replacer(match):
    return """def update_unified_timeline():
        cams = ["source", "sink", "hq"]
        anchor_cam = max(cams, key=lambda c: len(all_segs[c]))
        max_segs = len(all_segs[anchor_cam])
        
        while len(unified_steps) < max_segs:
            anchor_seg_idx = len(unified_steps)
            if anchor_seg_idx < len(all_segs[anchor_cam]):
                anchor_dur, anchor_name = all_segs[anchor_cam][anchor_seg_idx]
                anchor_abs_idx = parse_abs_seg_idx(anchor_name)
                anchor_start_frame = None
                if anchor_abs_idx is not None:
                    anchor_start_frame = seg_to_frame[anchor_cam].get(anchor_abs_idx)
            else:
                anchor_dur, anchor_name = 0.0, None
                anchor_abs_idx = None
                anchor_start_frame = None
            seg_indices = {}
            durs = {}
            names = {}
            
            for cam in cams:
                if cam == anchor_cam:
                    seg_idx_cam = anchor_seg_idx
                else:
                    map_key = f"{anchor_cam}_to_{cam}"
                    target_f = None
                    if anchor_start_frame is not None:
                        if anchor_start_frame in sync_maps[map_key]:
                            target_f = sync_maps[map_key][anchor_start_frame]
                        elif sync_maps[map_key]:
                            closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - anchor_start_frame))
                            target_f = sync_maps[map_key][closest]
                    
                    if target_f is not None and target_f in frame_to_seg[cam]:
                        mapped_abs_idx = frame_to_seg[cam][target_f][0]
                        mapped_list_idx = None
                        for i, item in enumerate(all_segs[cam]):
                            if parse_abs_seg_idx(item[1]) == mapped_abs_idx:
                                mapped_list_idx = i
                                break
                        if mapped_list_idx is not None:
                            prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                            seg_idx_cam = max(mapped_list_idx, prev + 1 if prev != -1 else mapped_list_idx)
                        else:
                            prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                            seg_idx_cam = prev + 1 if prev != -1 else anchor_seg_idx
                    else:
                        prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                        seg_idx_cam = prev + 1 if prev != -1 else anchor_seg_idx
                        
                seg_indices[cam] = seg_idx_cam
                if seg_idx_cam < len(all_segs[cam]):
                    durs[cam] = all_segs[cam][seg_idx_cam][0]
                    names[cam] = all_segs[cam][seg_idx_cam][1]
                else:
                    durs[cam] = 0.0
                    names[cam] = None
                    
            t_start = 0.0
            if anchor_start_frame is not None:
                t_start = anchor_start_frame / 30.0
            elif unified_steps:
                t_start = unified_steps[-1]["t_start"] + unified_steps[-1]["dur_global"]
                
            unified_steps.append({
                "t_start": t_start,
                "dur_global": 4.0,
                "orig_durs": durs,
                "names": names,
                "seg_indices": seg_indices
            })"""

# Match the old definition of update_unified_timeline exactly
pattern = r'def update_unified_timeline\(\):\n\s+# Iterate over source segments\n\s+max_segs = max\(len\(all_segs\[cam\]\) for cam in \["source", "sink", "hq"\]\)\n\s+while len\(unified_steps\) < max_segs:(.*?)\"seg_indices\": seg_indices\n\s+\}\)'

new_content = re.sub(pattern, replacer, content, flags=re.DOTALL)

with open('tri_stream_server2.py', 'w') as f:
    f.write(new_content)

print("Patch applied")
