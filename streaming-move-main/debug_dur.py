import os, sys
sys.path.append(os.getcwd())
import tri_stream_server2

# We need to simulate the load and then check scheduled_segs
import time
import threading

def run_debug():
    tri_stream_server2.IS_LIVE = False
    tri_stream_server2.SESSION_ID = "1645"
    
    # Let's just read the all_segs from the fallback manually
    from tri_stream_server2 import parse_playlist, get_segment_start_frame, get_global_time, parse_abs_seg_idx, seg_to_frame, seg_frame_count, sync_maps
    import pandas as pd
    import io
    
    # Load CSVs
    def load_csvs():
        # load sync
        sync_csv = "/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/segments_1645/sync/hls_sync_1645_triple.csv"
        df = pd.read_csv(sync_csv)
        for _, row in df.iterrows():
            src_idx = int(row['Source_Index'])
            snk_idx = int(row['Sink_Index'])
            hq_idx = int(row['HQ_Index'])
            sync_maps["source_to_sink"][src_idx] = snk_idx
            sync_maps["source_to_hq"][src_idx]   = hq_idx
            sync_maps["sink_to_source"][snk_idx]  = src_idx
            sync_maps["sink_to_hq"][snk_idx]      = hq_idx
            sync_maps["hq_to_source"][hq_idx]     = src_idx
            sync_maps["hq_to_sink"][hq_idx]       = snk_idx
            
        # load frame indices
        for cam in ["source", "sink", "hq"]:
            idx_csv = f"/Users/aryamirani/Desktop/intern/judex/ssh/test_work/cv_output/reader/{cam}/hls_segment_frame_index.csv"
            df_idx = pd.read_csv(idx_csv)
            for _, row in df_idx.iterrows():
                abs_idx = int(row['segment_index'])
                c_start = int(row['cumulative_start_frame'])
                f_count = int(row['frame_count'])
                seg_to_frame[cam][abs_idx] = c_start
                seg_frame_count[cam][abs_idx] = f_count
                
    load_csvs()
    
    for cam in ["source", "sink", "hq"]:
        m3u8_file = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/1645/playlist.m3u8"
        segs, _ = parse_playlist(m3u8_file)
        
        scheduled = []
        for idx, (dur, name) in enumerate(segs):
            abs_idx = parse_abs_seg_idx(name)
            start_global = 0.0
            if abs_idx is not None:
                f_start = get_segment_start_frame(cam, abs_idx)
                start_global = get_global_time(cam, f_start)
            else:
                if scheduled:
                    start_global = scheduled[-1]["t_start"] + scheduled[-1]["orig_dur"]
            scheduled.append({
                "name": name,
                "abs_idx": abs_idx if abs_idx is not None else idx,
                "t_start": start_global,
                "orig_dur": dur,
                "dur_global": dur
            })
            
        for i in range(len(scheduled) - 1):
            scheduled[i]["dur_global"] = scheduled[i+1]["t_start"] - scheduled[i]["t_start"]
            
        if scheduled:
            last = scheduled[-1]
            fc = seg_frame_count[cam].get(last["abs_idx"])
            last["dur_global"] = (fc / 30.0) if fc else last["orig_dur"]
            
        print(f"--- {cam} ---")
        anomalies = []
        for i, s in enumerate(scheduled):
            if s["dur_global"] < 0 or s["dur_global"] > 10.0:
                anomalies.append((i, s))
        if anomalies:
            print(f"Found {len(anomalies)} anomalies in {cam}:")
            for i, s in anomalies[:5]:
                print(f"  idx={i} name={s['name']} t_start={s['t_start']} dur_global={s['dur_global']}")
        else:
            print("No anomalies.")

run_debug()
