import re

# PATCH FOR sim.py
with open('tri_stream_Server_sim.py', 'r') as f:
    sim_content = f.read()

# 1. Change WINDOW_SIZE = 30 to WINDOW_SIZE = 35
sim_content = re.sub(r'WINDOW_SIZE = 30', 'WINDOW_SIZE = 35', sim_content)

# 2. Change occurrences of 30 in get_live_m3u8 to WINDOW_SIZE
# (Specifically exposed_segments[-30:] and seq_num = max(0, len(exposed_segments) - 30))
sim_content = re.sub(r'exposed_segments\[-30:\]', 'exposed_segments[-WINDOW_SIZE:]', sim_content)
sim_content = re.sub(r'max\(0, len\(exposed_segments\) - 30\)', 'max(0, len(exposed_segments) - WINDOW_SIZE)', sim_content)
sim_content = re.sub(r'max 30 segments', 'max {WINDOW_SIZE} segments', sim_content)

# 3. Remove master_stream_worker completely
sim_content = re.sub(r'def master_stream_worker\(\):.*?@asynccontextmanager', '@asynccontextmanager', sim_content, flags=re.DOTALL)

# 4. Remove master_stream_worker from lifespan
sim_content = re.sub(r'    threading\.Thread\(target=master_stream_worker, daemon=True\)\.start\(\)\n', '', sim_content)

with open('tri_stream_Server_sim.py', 'w') as f:
    f.write(sim_content)

# PATCH FOR sim_real.py
with open('tri_Stream_Server_sim_real.py', 'r') as f:
    real_content = f.read()

# 1. Change WINDOW_SIZE = 30 to WINDOW_SIZE = 35
real_content = re.sub(r'WINDOW_SIZE = 30', 'WINDOW_SIZE = 35', real_content)

with open('tri_Stream_Server_sim_real.py', 'w') as f:
    f.write(real_content)

print("Patch complete")
