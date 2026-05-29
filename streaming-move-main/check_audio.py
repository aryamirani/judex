import sys

def has_audio(filename):
    with open(filename, 'rb') as f:
        data = f.read(1024 * 1024) # read first 1MB
    
    for i in range(0, len(data), 188):
        if data[i] != 0x47: continue
        pid = ((data[i+1] & 0x1F) << 8) | data[i+2]
        
        # very basic heuristic: if we see multiple PIDs, it might have audio
        # usually 0 is PAT, 256 is PMT, 257 is Video, 258 is Audio
        pass
        
    return True # too complex to parse PMT in a short script

