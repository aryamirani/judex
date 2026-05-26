target_frame = -19
frame_to_seg = {0: (0, 0), 180: (1, 0), 360: (2, 0)}

available = list(frame_to_seg.keys())
closest_start = min(available, key=lambda x: abs(x - target_frame))
t_seg, base_offset = frame_to_seg[closest_start]
t_frame_offset = base_offset + (target_frame - closest_start)

print(f"t_seg: {t_seg}, t_frame_offset: {t_frame_offset}")
