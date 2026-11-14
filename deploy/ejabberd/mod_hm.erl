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
%%%    <hm xmlns='urn:hiddenmessenger:1' v='1' g='1'/>, with a receipt request and store hints, exactly like a direct
%%%    message (so offline storage and the wake-up apply per device). The sender gets <fanout-ack id='G' n='N'/>.
%%%    The server sees only addresses and ciphertext.
-module(mod_hm).
-behaviour(gen_mod).

-export([start/2, stop/1, reload/3, depends/2, mod_options/1, mod_opt_type/1, mod_doc/0]).
-export([offline_message/1, user_send_packet/1]).

-include("logger.hrl").
-include_lib("xmpp/include/xmpp.hrl").

-define(NS_FANOUT, <<"urn:hiddenmessenger:fanout:1">>).
-define(NS_HM, <<"urn:hiddenmessenger:1">>).
-define(MAX_ITEMS, 1024).

start(Host, _Opts) ->
    {ok, _} = application:ensure_all_started(inets),
    {ok, _} = application:ensure_all_started(ssl),
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
mod_opt_type(hook_key) -> econf:binary().

mod_options(_Host) -> [{hook_url, <<>>}, {hook_key, <<>>}].

mod_doc() -> #{desc => [<<"Hidden Messenger: offline wake-up hook and group fan-out.">>]}.

%%% --- 1. Offline wake-up ---------------------------------------------------------------------------------

offline_message({offlined, #message{to = #jid{luser = LUser, lserver = LServer}}} = Acc) ->
    case device_localpart(LUser) of
        true -> notify(LServer, LUser);
        false -> ok
    end,
    Acc;
offline_message(Acc) ->
    Acc.

notify(LServer, LUser) ->
    Url = gen_mod:get_module_opt(LServer, ?MODULE, hook_url),
    Key = gen_mod:get_module_opt(LServer, ?MODULE, hook_key),
    case {Url, Key} of
        {<<>>, _} -> ok;
        {_, <<>>} -> ok;
        _ ->
            Body = iolist_to_binary([<<"{\"to\":\"">>, LUser, <<"\",\"ts\":">>,
                                     integer_to_binary(erlang:system_time(second)), <<"}">>]),
            KeyBytes = base64:decode(Key, #{mode => urlsafe, padding => false}),
            Sig = binary:encode_hex(crypto:mac(hmac, sha256, KeyBytes, Body), lowercase),
            Headers = [{"x-hm-signature", binary_to_list(Sig)}, {"user-agent", "hm-ejabberd/1"}],
            SslOpts = [{verify, verify_peer}, {cacerts, public_key:cacerts_get()},
                       {customize_hostname_check, [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}],
            Request = {binary_to_list(Url), Headers, "application/json", Body},
            case httpc:request(post, Request, [{timeout, 8000}, {connect_timeout, 4000}, {ssl, SslOpts}],
                               [{sync, false}, {receiver, fun(_Reply) -> ok end}]) of
                {ok, _RequestId} -> ok;
                {error, Reason} -> ?WARNING_MSG("mod_hm: wake-up hook not sent: ~p", [Reason])
            end
    end.

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
user_send_packet(Acc) ->
    Acc.

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

fan_out(From, LServer, Msg, #xmlel{children = Children} = El) ->
    Id = fanout_id(Msg, El),
    Items = [{To, fxml:get_tag_cdata(Item)}
             || #xmlel{name = <<"item">>, attrs = ItemAttrs} = Item <- Children,
                To <- [fxml:get_attr_s(<<"to">>, ItemAttrs)],
                device_localpart(To)],
    Selected = lists:sublist(Items, ?MAX_ITEMS),
    lists:foreach(
      fun({To, Payload}) ->
              ejabberd_router:route(#message{
                id = Id, type = chat, from = From, to = jid:make(To, LServer),
                sub_els = [#xmlel{name = <<"hm">>,
                                  attrs = [{<<"xmlns">>, ?NS_HM}, {<<"v">>, <<"1">>}, {<<"g">>, <<"1">>}],
                                  children = [{xmlcdata, Payload}]},
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
