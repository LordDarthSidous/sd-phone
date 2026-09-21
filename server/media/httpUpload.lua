---@type table HTTP upload ingest; the table returned at end of file. Takes a recording from the
---phone over the server's own HTTP port, so its bytes never travel as a game network event.
local httpUpload = {}

---@class HttpUploadSlot
---@field src integer Player the slot was minted for.
---@field maxBytes integer Largest assembled body the slot accepts.
---@field expires integer os.time() after which the slot is dead; pushed back as each part lands.
---@field parts string[] Parts received so far, in order.
---@field received integer Bytes received so far.
---@field busy boolean True while a part's body is still arriving.
---@field onBody fun(src: integer, body: string) Receives the assembled body once the last part lands.

---@type integer Seconds a slot survives without a part arriving.
local SLOT_TTL <const> = 60

---@type integer Largest single part, in bytes. FXServer's HTTP server drops a request whose body
---is over 5 MiB, measured 2026-09-21: 5120 KB arrives and 5200 KB is cut off.
local MAX_PART_BYTES <const> = 4 * 1024 * 1024

---@type table<string, HttpUploadSlot> Live slots by token.
local slots = {}

---@type table<integer, string> Token of each player's live slot; one slot per player.
local tokenOf = {}

---@type table<string, string> Headers sent on every answer, so the phone's page may read it.
local CORS <const> = {
    ['Access-Control-Allow-Origin']  = '*',
    ['Access-Control-Allow-Methods'] = 'POST, OPTIONS',
    ['Access-Control-Allow-Headers'] = 'Content-Type',
    ['Content-Type']                 = 'application/json',
}

---Builds an unguessable 128-bit token.
---@return string token 32 hex characters.
local function newToken()
    return ('%08x%08x%08x%08x'):format(
        math.random(0, 0xFFFFFFFF), math.random(0, 0xFFFFFFFF),
        math.random(0, 0xFFFFFFFF), math.random(0, 0xFFFFFFFF))
end

---Closes a slot.
---@param token string
local function close(token)
    local slot = slots[token]
    if not slot then return end
    slots[token] = nil
    if tokenOf[slot.src] == token then tokenOf[slot.src] = nil end
end

---Closes a player's live slot, if any.
---@param src integer
function httpUpload.forget(src)
    local token = tokenOf[src]
    if token then close(token) end
end

---Opens an upload slot for a player, replacing any slot they already hold.
---@param src integer
---@param maxBytes integer Largest assembled body to accept.
---@param onBody fun(src: integer, body: string) Called with the assembled body once it has arrived.
---@return table slot { path: string, partBytes: integer } where to POST and how large a part may be.
function httpUpload.mint(src, maxBytes, onBody)
    httpUpload.forget(src)
    local token = newToken()
    slots[token] = {
        src = src, maxBytes = maxBytes, expires = os.time() + SLOT_TTL,
        parts = {}, received = 0, busy = false, onBody = onBody,
    }
    tokenOf[src] = token
    return { path = '/upload/' .. token, partBytes = MAX_PART_BYTES }
end

---Answers a request with a status and a JSON body.
---@param res table FXServer HTTP response.
---@param status integer
---@param body table
local function reply(res, status, body)
    res.writeHead(status, CORS)
    res.send(json.encode(body))
end

---Reads the declared body size from a request's headers.
---@param headers table<string, string>|nil
---@return integer|nil length
local function contentLength(headers)
    if type(headers) ~= 'table' then return nil end
    return math.tointeger(tonumber(headers['Content-Length'] or headers['content-length']))
end

---Serves POST /upload/<token>/<part>/<total>: parts arrive in order, one at a time, and the last
---one hands the assembled body to the slot's owner.
SetHttpHandler(function(req, res)
    if req.method == 'OPTIONS' then return reply(res, 204, {}) end
    if req.method ~= 'POST' then return reply(res, 405, { ok = false, code = 'method' }) end

    local token, part, total
    if type(req.path) == 'string' then
        token, part, total = req.path:match('^/upload/(%x+)/(%d+)/(%d+)$')
    end
    local slot = token and slots[token]
    if not token or not slot then return reply(res, 403, { ok = false, code = 'no-slot' }) end

    part, total = math.tointeger(tonumber(part)), math.tointeger(tonumber(total))
    local length = contentLength(req.headers)
    local fits = length and length > 0 and length <= MAX_PART_BYTES
        and slot.received + length <= slot.maxBytes
    if not part or not total or os.time() > slot.expires or slot.busy
        or part ~= #slot.parts + 1 or part > total or not fits then
        close(token)
        return reply(res, fits == false and 413 or 403, { ok = false, code = 'refused' })
    end

    slot.busy = true
    req.setDataHandler(function(body)
        slot.busy = false
        if slots[token] ~= slot then return reply(res, 403, { ok = false, code = 'no-slot' }) end
        if type(body) ~= 'string' or #body > MAX_PART_BYTES or slot.received + #body > slot.maxBytes then
            close(token)
            return reply(res, 413, { ok = false, code = 'too-large' })
        end

        slot.parts[part] = body
        slot.received = slot.received + #body
        slot.expires = os.time() + SLOT_TTL
        reply(res, 200, { ok = true })

        if part == total then
            close(token)
            slot.onBody(slot.src, table.concat(slot.parts))
        end
    end)
end)

---Sweeps slots nobody finished, so an abandoned upload does not hold its parts in memory.
CreateThread(function()
    while true do
        Wait(30000)
        local now = os.time()
        for token, slot in pairs(slots) do
            if now > slot.expires then close(token) end
        end
    end
end)

---Drops a departing player's slot.
AddEventHandler('playerDropped', function() httpUpload.forget(source) end)

return httpUpload
