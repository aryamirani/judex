import sys

file_path = "/Users/aryamirani/Desktop/intern/judex/streaming-move-main/tri_Stream_Server_sim_real.py"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace(
    """            else:
                segs[cam] = int(f_num / 120)
                offs[cam] = (f_num % 120) / FPS""",
    """            else:
                avg_fc = 120 if not seg_frame_count[cam] else list(seg_frame_count[cam].values())[-1]
                segs[cam] = int(f_num / avg_fc)
                offs[cam] = (f_num % avg_fc) / FPS"""
)

content = content.replace(
    """        if not keys:
            return abs_idx * 120
        closest_seg = min(keys, key=lambda x: abs(x - abs_idx))
        return seg_to_frame[cam][closest_seg] + (abs_idx - closest_seg) * 120""",
    """        if not keys:
            return abs_idx * 120
        closest_seg = min(keys, key=lambda x: abs(x - abs_idx))
        fc = seg_frame_count[cam].get(closest_seg, 120)
        return seg_to_frame[cam][closest_seg] + (abs_idx - closest_seg) * fc"""
)

content = content.replace(
    """            if seg_to_frame[from_camera]:
                closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - from_seg))
                start_frame = seg_to_frame[from_camera][closest_seg] + (from_seg - closest_seg) * 120
            else:""",
    """            if seg_to_frame[from_camera]:
                closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - from_seg))
                fc = seg_frame_count[from_camera].get(closest_seg, 120)
                start_frame = seg_to_frame[from_camera][closest_seg] + (from_seg - closest_seg) * fc
            else:"""
)

content = content.replace(
    """            else:
                t_seg = int(target_frame / 120)
                t_frame_offset = target_frame % 120""",
    """            else:
                avg_fc = 120 if not seg_frame_count[target_cam] else list(seg_frame_count[target_cam].values())[-1]
                t_seg = int(target_frame / avg_fc)
                t_frame_offset = target_frame % avg_fc"""
)

content = content.replace(
    """                if seg_to_frame[from_camera]:
                    closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - sn))
                    start_frame = seg_to_frame[from_camera][closest_seg] + (sn - closest_seg) * 120
                else:""",
    """                if seg_to_frame[from_camera]:
                    closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - sn))
                    fc = seg_frame_count[from_camera].get(closest_seg, 120)
                    start_frame = seg_to_frame[from_camera][closest_seg] + (sn - closest_seg) * fc
                else:"""
)

content = content.replace(
    """                    else:
                        t_seg = int(target_frame / 120)
                        t_frame_offset = target_frame % 120""",
    """                    else:
                        avg_fc = 120 if not seg_frame_count[target_cam] else list(seg_frame_count[target_cam].values())[-1]
                        t_seg = int(target_frame / avg_fc)
                        t_frame_offset = target_frame % avg_fc"""
)

content = content.replace(
    """                if seg_to_frame[cam]:
                    closest_seg = min(seg_to_frame[cam].keys(), key=lambda x: abs(x - seg))
                    frames[cam] = seg_to_frame[cam][closest_seg] + (seg - closest_seg) * 120 + int(off * FPS)
                else:""",
    """                if seg_to_frame[cam]:
                    closest_seg = min(seg_to_frame[cam].keys(), key=lambda x: abs(x - seg))
                    fc = seg_frame_count[cam].get(closest_seg, 120)
                    frames[cam] = seg_to_frame[cam][closest_seg] + (seg - closest_seg) * fc + int(off * FPS)
                else:"""
)

with open(file_path, "w") as f:
    f.write(content)

print("Patch applied successfully.")
