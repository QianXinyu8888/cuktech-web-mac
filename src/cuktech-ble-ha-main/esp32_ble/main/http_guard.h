#pragma once
#include <stdbool.h>
bool http_guard_request(const char *host,const char *origin,const char *fetch_site,const char *content_type,bool post,const char *ip1,const char *ip2);
bool http_guard_cloud_change(const char *old_url,const char *new_url,const char *old_token,const char *submitted_token);
