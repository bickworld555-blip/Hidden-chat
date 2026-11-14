%%% Hidden Messenger extensions for ejabberd (BEAM/XMPP move, phase 2).
%%%
%%% 1. Offline wake-up: when mod_offline has stored a message for a device that is not connected, POST
%%%    {"to": localpart, "ts": seconds} to the Node API (hook_url), signed with HMAC-SHA256 under the shared JWT key
%%%    (hook_key, base64url) in the x-hm-signature header. The API sends that device's encrypted FCM wake-up.
%%%    Nothing about the message is sent.
%%% 2. Group fan-out: a device sends ONE stanza to the server itself,
%%%      <message to='chat.hiddenmessenger.com' id='G'><fanout xmlns='urn:hiddenmessenger:fanout:1' id='G'>
%%%        <item to='d...'>BASE64</item> ... </fanout></message>
%%%    and each item goes out as its own message from the sender to d...@host, carrying the item's payload in
%%%    <hm xmlns='urn:hiddenmessenger:1' v='1' g u d/> (g, u, d copied from <fanout>: group flag, sender user and
%%%    device ids, which the receiver checks against the sending address), with a receipt request and store hints, like a direct
%%%    message (so offline storage and the wake-up apply per device). The sender gets <fanout-ack id='G' n='N'/>.
%%%    The server sees only addresses and ciphertext.
%%% 3. Who may reach whom: before relaying a message, IQ or directed presence from one device to another, and for every
%%%    fan-out item, ask the Node API (check_url, same signature) for a verdict per target: allow, deny (refused: the
%%%    sender gets a not-allowed error) or drop (silently not delivered: the recipient blocked the sender). The rules
%%%    are the Node server's (blocks, deleted accounts; group fan-out also reaches members who share a group). Verdicts
%%%    are cached for 30 s per (sender, target, group); when the API cannot be reached the stanza is refused.
-module(mod_hm).
-behaviour(gen_mod).

-export([start/2, stop/1, reload/3, depends/2, mod_options/1, mod_opt_type/1, mod_doc/0]).
-export([offline_message/1, user_send_packet/1]).

-include("logger.hrl").
-include_lib("xmpp/include/xmpp.hrl").

-define(NS_FANOUT, <<"urn:hiddenmessenger:fanout:1">>).
-define(NS_HM, <<"urn:hiddenmessenger:1">>).
-define(MAX_ITEMS, 1024).
-define(VERDICTS, hm_verdicts).
-define(VERDICT_LIFE_MS, 30000).

start(Host, _Opts) ->
    {ok, _} = application:ensure_all_started(inets),
    {ok, _} = application:ensure_all_started(ssl),
    ets_cache:new(?VERDICTS, [{max_size, 200000}, {life_time, ?VERDICT_LIFE_MS}, {cache_missed, false}]),
    %% After mod_offline (50), so the message is already stored when the device is woken.
    ejabberd_hooks:add(offline_message_hook, Host, ?MODULE, offline_message, 60),
    ejabberd_hooks:add(user_send_packet, Host, ?MODULE, user_send_packet, 40),
    ok.

stop(Host) ->
    ejabberd_hooks:delete(offline_message_hook, Host, ?MODULE, offline_message, 60),
    ejabberd_hooks:delete(user_send_packet, Host, ?MODULE, user_send_packet, 40),
    ok.

reload(_Host, _NewOpts, _OldOpts) -> ok.

depends(_Host, _Opts) -> [{mod_offline, hard}].

mod_opt_type(hook_url) -> econf:binary();
mod_opt_type(check_url) -> econf:binary();
mod_opt_type(hook_key) -> econf:binary().

mod_options(_Host) -> [{hook_url, <<>>}, {check_url, <<>>}, {hook_key, <<>>}].

mod_doc() -> #{desc => [<<"Hidden Messenger: offline wake-up hook and group fan-out.">>]}.

%%% --- 1. Offline wake-up ---------------------------------------------------------------------------------

offline_message({offlined, #message{to = #jid{luser = LUser, lserver = LServer}, from = From, sub_els = Els}} = Acc) ->
    case device_localpart(LUser) of
        true -> notify(LServer, LUser, sender_localpart(From), group_of(Els));
        false -> ok
    end,
    Acc;
offline_message(Acc) ->
    Acc.

ssl_opts() ->
    [{verify, verify_peer}, {cacerts, public_key:cacerts_get()},
     {customize_hostname_check, [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}].

signed_headers(Key, Body) ->
    KeyBytes = base64:decode(Key, #{mode => urlsafe, padding => false}),
    Sig = binary:encode_hex(crypto:mac(hmac, sha256, KeyBytes, Body), lowercase),
    [{"x-hm-signature", binary_to_list(Sig)}, {"user-agent", "hm-ejabberd/1"}].

%% The sending device, when it is one (the push then names the sender, as today's message pushes do).
sender_localpart(#jid{luser = FromUser}) ->
    case device_localpart(FromUser) of
        true -> FromUser;
        false -> <<>>
    end;
sender_localpart(_) ->
    <<>>.

%% The group a stored message belongs to (the gid fan-out copied into its <hm>), or <<>>.
group_of(Els) ->
    case [fxml:get_attr_s(<<"gid">>, Attrs) || #xmlel{name = <<"hm">>, attrs = Attrs} <- Els, fxml:get_attr_s(<<"xmlns">>, Attrs) =:= ?NS_HM] of
        [Gid | _] -> Gid;
        [] -> <<>>
    end.

notify(LServer, LUser, FromUser, Group) ->
    Url = gen_mod:get_module_opt(LServer, ?MODULE, hook_url),
    Key = gen_mod:get_module_opt(LServer, ?MODULE, hook_key),
    case {Url, Key} of
        {<<>>, _} -> ok;
        {_, <<>>} -> ok;
        _ ->
            Body = iolist_to_binary(json:encode(#{<<"to">> => LUser, <<"from">> => FromUser, <<"group">> => Group,
                                                   <<"ts">> => erlang:system_time(second)})),
            Request = {binary_to_list(Url), signed_headers(Key, Body), "application/json", Body},
            case httpc:request(post, Request, [{timeout, 8000}, {connect_timeout, 4000}, {ssl, ssl_opts()}],
                               [{sync, false}, {receiver, fun(Reply) -> log_reply(LUser, Reply) end}]) of
                {ok, _RequestId} -> ok;
                {error, Reason} -> ?WARNING_MSG("mod_hm: wake-up hook not sent: ~p", [Reason])
            end
    end.

%% The API answers 202 when the hook is accepted; anything else is worth seeing in the log.
log_reply(LUser, {_RequestId, {{_, 202, _}, _Headers, _Body}}) ->
    ?INFO_MSG("mod_hm: wake-up hook accepted for ~s", [LUser]);
log_reply(LUser, {_RequestId, {{_, Status, _}, _Headers, _Body}}) ->
    ?WARNING_MSG("mod_hm: wake-up hook for ~s answered ~p", [LUser, Status]);
log_reply(LUser, {_RequestId, {error, Reason}}) ->
    ?WARNING_MSG("mod_hm: wake-up hook for ~s failed: ~p", [LUser, Reason]);
log_reply(_LUser, _Other) ->
    ok.

%%% --- 2. Group fan-out --------------------------------------------------------------------------------------

user_send_packet({#message{to = #jid{luser = <<>>, lresource = <<>>, lserver = LServer}, from = From} = Msg, State} = Acc)
  when From =/= undefined ->
    case find_fanout(Msg#message.sub_els) of
        false -> Acc;
        El ->
            N = fan_out(From, LServer, Msg, El),
            ejabberd_router:route(#message{
                from = jid:make(LServer), to = From, type = normal,
                sub_els = [#xmlel{name = <<"fanout-ack">>,
                                  attrs = [{<<"xmlns">>, ?NS_FANOUT}, {<<"id">>, fanout_id(Msg, El)},
                                           {<<"n">>, integer_to_binary(N)}]}]}),
            {stop, {drop, State}}
    end;
%% Anything else addressed to another device: the Node server's rules decide.
user_send_packet({Pkt, State} = Acc) when is_record(Pkt, message); is_record(Pkt, iq); is_record(Pkt, presence) ->
    From = xmpp:get_from(Pkt),
    To = xmpp:get_to(Pkt),
    case relayed_between_devices(From, To) of
        false -> Acc;
        true ->
            case maps:get(To#jid.luser, verdicts(From#jid.lserver, From#jid.luser, [To#jid.luser], false), <<"deny">>) of
                <<"allow">> -> Acc;
                <<"drop">> -> {stop, {drop, State}};
                _ ->
                    refuse(Pkt),
                    {stop, {drop, State}}
            end
    end;
user_send_packet(Acc) ->
    Acc.

relayed_between_devices(#jid{luser = FromUser}, #jid{luser = ToUser}) ->
    FromUser =/= ToUser andalso device_localpart(FromUser) andalso device_localpart(ToUser);
relayed_between_devices(_, _) ->
    false.

%% Errors are never answered with errors (no loops); everything else gets not-allowed back.
refuse(#message{type = error}) -> ok;
refuse(#presence{type = error}) -> ok;
refuse(#iq{type = T}) when T =:= error; T =:= result -> ok;
refuse(Pkt) -> ejabberd_router:route(xmpp:make_error(Pkt, xmpp:err_not_allowed())).

%% Verdict per target localpart: cached ones, then one signed call for the rest. A failed call refuses (not cached).
verdicts(LServer, FromUser, Targets, Group) ->
    {Known, Missing} = lists:foldl(
        fun(To, {K, M}) ->
            case ets_cache:lookup(?VERDICTS, {FromUser, To, Group}, fun() -> error end) of
                {ok, V} -> {K#{To => V}, M};
                error -> {K, [To | M]}
            end
        end, {#{}, []}, lists:usort(Targets)),
    case Missing of
        [] -> Known;
        _ ->
            case fetch_verdicts(LServer, FromUser, Missing, Group) of
                {ok, Fetched} ->
                    maps:foreach(fun(To, V) -> ets_cache:insert(?VERDICTS, {FromUser, To, Group}, V) end, Fetched),
                    maps:merge(Known, Fetched);
                error ->
                    maps:merge(maps:from_list([{To, <<"deny">>} || To <- Missing]), Known)
            end
    end.

fetch_verdicts(LServer, FromUser, Targets, Group) ->
    Url = gen_mod:get_module_opt(LServer, ?MODULE, check_url),
    Key = gen_mod:get_module_opt(LServer, ?MODULE, hook_key),
    case {Url, Key} of
        {<<>>, _} -> {ok, maps:from_list([{T, <<"allow">>} || T <- Targets])};
        {_, <<>>} -> {ok, maps:from_list([{T, <<"allow">>} || T <- Targets])};
        _ ->
            GroupFields = case Group of
                              {Gid, Mh} -> #{<<"group">> => true, <<"groupId">> => Gid, <<"membersHash">> => Mh};
                              _ -> #{<<"group">> => Group}
                          end,
            Body = iolist_to_binary(json:encode(GroupFields#{<<"from">> => FromUser, <<"to">> => Targets,
                                                              <<"ts">> => erlang:system_time(second)})),
            Request = {binary_to_list(Url), signed_headers(Key, Body), "application/json", Body},
            case httpc:request(post, Request, [{timeout, 5000}, {connect_timeout, 3000}, {ssl, ssl_opts()}],
                               [{body_format, binary}]) of
                {ok, {{_, 200, _}, _Headers, Reply}} ->
                    try json:decode(Reply) of
                        #{<<"verdicts">> := #{} = V} -> {ok, maps:with(Targets, V)};
                        _ -> error
                    catch _:_ -> error
                    end;
                Other ->
                    ?WARNING_MSG("mod_hm: delivery check failed: ~p", [element(1, Other)]),
                    error
            end
    end.

find_fanout([]) -> false;
find_fanout([#xmlel{name = <<"fanout">>, attrs = Attrs} = El | Rest]) ->
    case fxml:get_attr_s(<<"xmlns">>, Attrs) of
        ?NS_FANOUT -> El;
        _ -> find_fanout(Rest)
    end;
find_fanout([_ | Rest]) -> find_fanout(Rest).

fanout_id(Msg, #xmlel{attrs = Attrs}) ->
    case fxml:get_attr_s(<<"id">>, Attrs) of
        <<>> -> Msg#message.id;
        Id -> Id
    end.

fan_out(From, LServer, Msg, #xmlel{attrs = FanAttrs, children = Children} = El) ->
    Id = fanout_id(Msg, El),
    %% g="0": one person's devices (a direct message), so direct rules apply; anything else is a group message.
    IsGroup = fxml:get_attr_s(<<"g">>, FanAttrs) =/= <<"0">>,
    Gid = fxml:get_attr_s(<<"gid">>, FanAttrs),
    %% A group message names its group and members hash: the server checks posting rights and the hash (verdicts).
    Group = case {IsGroup, Gid} of
                {false, _} -> false;
                {true, <<>>} -> true;
                {true, _} -> {Gid, fxml:get_attr_s(<<"mh">>, FanAttrs)}
            end,
    HmAttrs = [{<<"xmlns">>, ?NS_HM}, {<<"v">>, <<"1">>}, {<<"g">>, case IsGroup of true -> <<"1">>; false -> <<"0">> end}]
              ++ [{K, V} || K <- [<<"u">>, <<"d">>, <<"gid">>], V <- [fxml:get_attr_s(K, FanAttrs)], V =/= <<>>],
    Items = lists:sublist([{To, fxml:get_tag_cdata(Item)}
                           || #xmlel{name = <<"item">>, attrs = ItemAttrs} = Item <- Children,
                              To <- [fxml:get_attr_s(<<"to">>, ItemAttrs)],
                              device_localpart(To)], ?MAX_ITEMS),
    %% Each member device must be reachable under the group rules; others are skipped (the ack counts the rest).
    Verdicts = case Items of
                   [] -> #{};
                   _ -> verdicts(LServer, From#jid.luser, [To || {To, _} <- Items], Group)
               end,
    Selected = [Item || {To, _} = Item <- Items, maps:get(To, Verdicts, <<"deny">>) =:= <<"allow">>],
    lists:foreach(
      fun({To, Payload}) ->
              ejabberd_router:route(#message{
                id = Id, type = chat, from = From, to = jid:make(To, LServer),
                sub_els = [#xmlel{name = <<"hm">>, attrs = HmAttrs, children = [{xmlcdata, Payload}]},
                           #xmlel{name = <<"request">>, attrs = [{<<"xmlns">>, <<"urn:xmpp:receipts">>}]},
                           #xmlel{name = <<"store">>, attrs = [{<<"xmlns">>, <<"urn:xmpp:hints">>}]},
                           #xmlel{name = <<"no-permanent-store">>, attrs = [{<<"xmlns">>, <<"urn:xmpp:hints">>}]}]})
      end, Selected),
    length(Selected).

%% Device accounts are "d" + 40 lowercase hex (server/xmpp.mjs localpartFor).
device_localpart(<<"d", Hex:40/binary>>) ->
    lists:all(fun(C) -> (C >= $0 andalso C =< $9) orelse (C >= $a andalso C =< $f) end, binary_to_list(Hex));
device_localpart(_) ->
    false.
