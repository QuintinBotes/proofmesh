<?php
namespace Shop\Http;

use Shop\Models\User;
use Shop\Models\User as Person;
use function Shop\Models\helper;
use Shop\Models;
use Plugin\Thing;

function local()
{
}

class Controller
{
    public function index($u)
    {
        new User();
        User::find(1);
        Person::find(2);
        Models\User::find(3);
        \Shop\Models\User::find(4);
        local();
        helper();
        \Shop\Models\helper();
        global_helper();
        strlen("x");
        $u->save();
        User::validate();
        Missing::find(5);
        Thing::run();
    }
}
