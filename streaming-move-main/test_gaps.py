import test_gaps
import re

with open("/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_source/1645/playlist.m3u8") as f:
    names = [l.strip() for l in f if l.strip().endswith('.ts')]

scheduled = []
for idx, name in enumerate(names):
    abs_idx = test_gaps.parse_abs_seg_idx(name)
    f_start = test_gaps.get_f_start("source", abs_idx)
    t_start = test_gaps.get_t_start("source", f_start)
    scheduled.append({"name": name, "abs_idx": abs_idx, "t_start": t_start})

for i in range(len(scheduled)-1):
    dur = scheduled[i+1]["t_start"] - scheduled[i]["t_start"]
    scheduled[i]["dur_global"] = dur

last_30 = scheduled[-30:]
total = 0
for s in last_30[:-1]:
    total += s["dur_global"]

print("Total duration of last 30:", total)
print("Last 5 items:")
for s in last_30[-5:]:
    print(s)
