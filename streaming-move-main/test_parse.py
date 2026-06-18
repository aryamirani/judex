def parse_abs_seg_idx(seg_name):
    import re
    match = re.search(r'seg_(\d+)\.ts', seg_name)
    return int(match.group(1)) if match else -1

print(parse_abs_seg_idx("1738/seg_00255.ts"))
