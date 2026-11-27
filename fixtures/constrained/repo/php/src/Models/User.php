<?php
namespace Shop\Models;

class User extends Base
{
    public static function find($id)
    {
        return new User();
    }

    public function save()
    {
        $this->validate();
        self::find(1);
        static::find(2);
        parent::boot();
    }

    private function validate()
    {
    }
}

function helper()
{
}
