#pragma once
#include "automation_engine.h"
typedef enum { AUTO_STORE_ERROR=-1, AUTO_STORE_EMPTY=0, AUTO_STORE_LOADED=1 } AutoStoreLoad;
AutoStoreLoad automation_store_load(AutoConfig *config);
/* Independent namespace, single versioned blob, commit then verify exact readback. */
bool automation_store_save(const AutoConfig *config);
/* Best-effort display checkpoint; it is never sufficient to resume a cutoff. */
bool automation_progress_save(const AutoEngine *engine);
bool automation_progress_load(AutoEngine *engine);
